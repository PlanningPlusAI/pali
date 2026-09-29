// Round-trip check for wordio: export a JSON doc with every style/mark, inspect the XML, re-import.
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { exportDocx, importDocx } from '../wordio.js'

const t = (text: string, ...marks: string[]) => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((m) => (m.startsWith('link:') ? { type: 'link', attrs: { href: m.slice(5) } } : { type: m })) } : {}) })
const p = (...content: any[]) => ({ type: 'paragraph', content })
const li = (...content: any[]) => ({ type: 'listItem', content })
const doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [t('Title H1')] },
    p(t('Body with '), t('bold', 'bold'), t(', '), t('italic', 'italic'), t(', '), t('underline', 'underline'), t(', '), t('strike', 'strike'), t(', '), t('code', 'code'), t(', a '), t('link', 'link:https://example.com'), t(' and $5 plus '), { type: 'inlineMath', attrs: { latex: 'x^2' } }),
    { type: 'heading', attrs: { level: 2 }, content: [t('H2')] },
    { type: 'bulletList', content: [li(p(t('bullet one'))), li(p(t('bullet two')), { type: 'bulletList', content: [li(p(t('nested')))] })] },
    { type: 'orderedList', content: [li(p(t('first'))), li(p(t('second')))] },
    p(t('between')),
    { type: 'orderedList', content: [li(p(t('restart one')))] },
    { type: 'blockquote', content: [p(t('a quote'))] },
    { type: 'codeBlock', content: [t('line1\nline2')] },
    { type: 'heading', attrs: { level: 4 }, content: [t('H4')] },
  ],
}

const buf = await exportDocx(doc, 'Round trip')
writeFileSync(process.argv[2] ?? 'wordio-test.docx', buf)
const JSZip = createRequire(import.meta.url)('jszip')
const zip = await JSZip.loadAsync(buf)
const xml: string = await zip.file('word/document.xml').async('string')
const styles: string = await zip.file('word/styles.xml').async('string')
const checks: [string, boolean][] = [
  ['Heading1 style used', xml.includes('w:val="Heading1"')],
  ['Heading2 style used', xml.includes('w:val="Heading2"')],
  ['Heading4 style used', xml.includes('w:val="Heading4"')],
  ['bold', xml.includes('<w:b/>') || xml.includes('<w:b ')],
  ['italic', xml.includes('<w:i/>') || xml.includes('<w:i ')],
  ['underline', xml.includes('<w:u ')],
  ['strike', xml.includes('<w:strike')],
  ['inline code char style', xml.includes('w:val="InlineCode"')],
  ['hyperlink', xml.includes('<w:hyperlink')],
  ['numbering', xml.includes('<w:numPr>')],
  ['nested level 1', xml.includes('<w:ilvl w:val="1"/>')],
  ['Quote style', xml.includes('w:val="Quote"')],
  ['Code style', xml.includes('w:val="Code"')],
  ['ListParagraph style', xml.includes('w:val="ListParagraph"')],
  ['legacy inline math as text', xml.includes('$x^2$')],
  ['styles.xml names Quote', styles.includes('w:val="Quote"')],
  ['styles.xml heading color', styles.includes('0F4761')],
]
const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1])
checks.push(['separate numbered lists restart (distinct numIds)', new Set(numIds).size >= 4])
const back = await importDocx('Round trip.docx', buf)
checks.push(['import: h1', back.html.includes('<h1>Title H1</h1>')])
checks.push(['import: underline', back.html.includes('<u>underline</u>')])
checks.push(['import: strike', back.html.includes('<s>strike</s>')])
checks.push(['import: code', back.html.includes('<code>code</code>')])
checks.push(['import: link', back.html.includes('href="https://example.com"')])
checks.push(['import: ul/ol', back.html.includes('<ul>') && back.html.includes('<ol>')])
checks.push(['import: blockquote', back.html.includes('<blockquote>')])
checks.push(['import: pre', back.html.includes('<pre>')])
checks.push(['import: h4', back.html.includes('<h4>')])
// A Word file with a table: import must warn and keep the cell text.
const { Document, Packer, Paragraph, Table, TableRow, TableCell } = await import('docx')
const cell = (s: string) => new TableCell({ children: [new Paragraph(s)] })
const tdoc = new Document({ sections: [{ children: [new Paragraph('Before table'), new Table({ rows: [new TableRow({ children: [cell('Cell A1'), cell('Cell B1')] }), new TableRow({ children: [cell('Cell A2'), cell('Cell B2')] })] }), new Paragraph('After table')] }] })
const tb = await importDocx('table.docx', await Packer.toBuffer(tdoc))
checks.push(['table: warning raised', tb.warnings.some((w) => w.includes('table'))])
checks.push(['table: cell text kept', ['Cell A1', 'Cell B2', 'After table'].every((s) => tb.html.includes(s))])
console.log('table html:', tb.html, '| warnings:', tb.warnings)
for (const [n, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`)
console.log('numIds:', numIds.join(','), '| warnings:', back.warnings)
console.log(back.html)
