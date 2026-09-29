// Word (.docx) import and export. Import: mammoth → HTML (the frontend parses it with the
// editor schema). Export: editor JSON → docx using Word's built-in style names, so headings,
// lists, quotes and character formatting land on real Word styles.
import mammoth from 'mammoth'
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun,
  type IRunOptions, type ParagraphChild,
} from 'docx'

// ---------- import ----------

const STYLE_MAP = [
  'u => u',
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
  "p[style-name='Quote'] => blockquote > p:fresh",
  "p[style-name='Intense Quote'] => blockquote > p:fresh",
  "p[style-name='Code'] => pre:separator('\\n')",
  "r[style-name='Inline Code'] => code",
  "r[style-name='HTML Code'] => code",
]

export async function importDocx(filename: string, buffer: Buffer): Promise<{ title: string; html: string; warnings: string[] }> {
  let images = 0
  const r = await (mammoth as any).convertToHtml({ buffer }, {
    styleMap: STYLE_MAP,
    convertImage: (mammoth as any).images.imgElement(async () => { images++; return { src: '' } }),
  }) as { value: string; messages: { type: string; message: string }[] }
  const html = r.value.replace(/<img[^>]*>/g, '')
  const tables = (html.match(/<table\b/g) ?? []).length
  const warnings: string[] = []
  if (images) warnings.push(`${images} image${images > 1 ? 's were' : ' was'} not brought over (the editor has no images).`)
  if (tables) warnings.push(`${tables} table${tables > 1 ? 's were' : ' was'} flattened to paragraphs (the editor has no tables).`)
  for (const m of r.messages) if (m.type === 'error') warnings.push(m.message)
  const title = filename.replace(/\.docx$/i, '').replace(/[_]+/g, ' ').trim() || 'Imported document'
  return { title, html, warnings }
}

// ---------- export ----------

interface J { type: string; attrs?: any; content?: J[]; text?: string; marks?: { type: string; attrs?: any }[] }

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6]
const BULLETS = ['•', '◦', '▪']
const NUM_FORMATS = [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN]
const levels = (fmt: (l: number) => { format: (typeof LevelFormat)[keyof typeof LevelFormat]; text: string }) =>
  Array.from({ length: 9 }, (_, l) => ({ level: l, ...fmt(l), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (l + 1), hanging: 360 } } } }))

function runs(nodes: J[] = []): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const n of nodes) {
    if (n.type === 'hardBreak') { out.push(new TextRun({ break: 1 })); continue }
    const text = n.type === 'text' ? n.text ?? '' : n.type === 'inlineMath' ? `$${n.attrs?.latex ?? ''}$` : ''
    if (!text) continue
    const marks = n.marks ?? []
    const has = (t: string) => marks.some((m) => m.type === t)
    const link = marks.find((m) => m.type === 'link')?.attrs?.href as string | undefined
    const opts: IRunOptions = {
      text,
      bold: has('bold') || undefined,
      italics: has('italic') || undefined,
      underline: has('underline') ? {} : undefined,
      strike: has('strike') || undefined,
      style: has('code') ? 'InlineCode' : link ? 'Hyperlink' : undefined,
    }
    out.push(link ? new ExternalHyperlink({ link, children: [new TextRun(opts)] }) : new TextRun(opts))
  }
  return out
}

function blocks(nodes: J[] = [], ctx: { quote: boolean; nextInstance: () => number }): Paragraph[] {
  const out: Paragraph[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        out.push(new Paragraph({ style: ctx.quote ? 'Quote' : undefined, children: runs(n.content) }))
        break
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[Math.min(Math.max((n.attrs?.level ?? 1) - 1, 0), 5)], children: runs(n.content) }))
        break
      case 'bulletList':
      case 'orderedList':
        out.push(...list(n, 0, ctx))
        break
      case 'blockquote':
        out.push(...blocks(n.content, { ...ctx, quote: true }))
        break
      case 'codeBlock': {
        const text = (n.content ?? []).map((c) => c.text ?? '').join('')
        for (const line of text.split('\n')) out.push(new Paragraph({ style: 'Code', children: [new TextRun(line)] }))
        break
      }
      case 'horizontalRule':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'auto', space: 1 } }, children: [] }))
        break
      case 'blockMath':
        out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: n.attrs?.latex ?? '', font: 'Cambria Math' })] }))
        break
      default:
        if (n.content) out.push(...blocks(n.content, ctx))
    }
  }
  return out
}

function list(n: J, level: number, ctx: { quote: boolean; nextInstance: () => number }): Paragraph[] {
  const reference = n.type === 'orderedList' ? 'pali-number' : 'pali-bullet'
  const instance = ctx.nextInstance() // each list numbers from 1
  const out: Paragraph[] = []
  for (const item of n.content ?? []) {
    let first = true
    for (const child of item.content ?? []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') { out.push(...list(child, Math.min(level + 1, 8), ctx)); continue }
      if (child.type === 'paragraph' || child.type === 'heading') {
        out.push(first
          ? new Paragraph({ numbering: { reference, level, instance }, children: runs(child.content) })
          : new Paragraph({ style: 'ListParagraph', indent: { left: 720 * (level + 1) }, children: runs(child.content) }))
        first = false
      } else out.push(...blocks([child], ctx))
    }
  }
  return out
}

const HEADING_COLOR = '0F4761'

export async function exportDocx(json: unknown, title: string): Promise<Buffer> {
  let inst = 0
  const doc = json as J
  const children = blocks(doc?.content ?? [], { quote: false, nextInstance: () => ++inst })
  const d = new Document({
    title,
    creator: 'Pali',
    styles: {
      default: {
        document: { run: { font: 'Aptos', size: 22 }, paragraph: { spacing: { after: 160, line: 278 } } },
        title: { run: { font: 'Aptos Display', size: 56 }, paragraph: { spacing: { after: 80 } } },
        heading1: { run: { font: 'Aptos Display', size: 40, color: HEADING_COLOR }, paragraph: { spacing: { before: 360, after: 80 }, keepNext: true } },
        heading2: { run: { font: 'Aptos Display', size: 32, color: HEADING_COLOR }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true } },
        heading3: { run: { font: 'Aptos', size: 28, color: HEADING_COLOR }, paragraph: { spacing: { before: 160, after: 80 }, keepNext: true } },
        heading4: { run: { font: 'Aptos', size: 22, italics: true, color: HEADING_COLOR }, paragraph: { spacing: { before: 80, after: 40 }, keepNext: true } },
        heading5: { run: { font: 'Aptos', size: 22, color: HEADING_COLOR }, paragraph: { spacing: { before: 80, after: 40 }, keepNext: true } },
        heading6: { run: { font: 'Aptos', size: 22, italics: true, color: '595959' }, paragraph: { spacing: { before: 40 }, keepNext: true } },
        listParagraph: { paragraph: { spacing: { after: 80 }, contextualSpacing: true } },
        hyperlink: { run: { color: '467886', underline: {} } },
      },
      paragraphStyles: [
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { italics: true, color: '404040' }, paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 200, after: 160 }, indent: { left: 864, right: 864 } } },
        { id: 'Code', name: 'Code', basedOn: 'Normal', quickFormat: true, run: { font: 'Consolas', size: 20 }, paragraph: { spacing: { after: 0, line: 240 } } },
      ],
      characterStyles: [
        { id: 'InlineCode', name: 'Inline Code', basedOn: 'DefaultParagraphFont', run: { font: 'Consolas', size: 20 } },
      ],
    },
    numbering: {
      config: [
        { reference: 'pali-bullet', levels: levels((l) => ({ format: LevelFormat.BULLET, text: BULLETS[l % 3] })) },
        { reference: 'pali-number', levels: levels((l) => ({ format: NUM_FORMATS[l % 3], text: `%${l + 1}.` })) },
      ],
    },
    sections: [{ children: children.length ? children : [new Paragraph('')] }],
  })
  return Packer.toBuffer(d)
}
