// Document ingestion (GOAL §8): convert at ingest, pure-JS extractors only, per-document files.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import * as XLSX from 'xlsx'
import { createRequire } from 'node:module'
import type { Provider } from './provider/types.js'
import type { DocMeta, Workspace } from './workspace.js'
import { log } from './log.js'

export interface FileEntry {
  name: string
  type: string
  size: number
  chars: number
  pages?: number
  status: 'ok' | 'warning' | 'error'
  warning?: string
  /** One-shot summary/outline for large files, generated once at ingest. */
  summary?: string
  addedAt: string
}

export interface FileIndex { files: FileEntry[] }

export const INLINE_LIMIT = 15_000 // chars: below this the full text is inlined (GOAL §8)
export const INLINE_BUDGET = 60_000 // total inline chars per prompt before degrading to summaries
const SCANNED_CHARS_PER_PAGE = 50

const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.json', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.ps1', '.html', '.css', '.xml', '.yaml', '.yml', '.toml', '.ini', '.sql', '.tex', '.bib', '.log'])

export function filesDir(ws: Workspace, slug: string) { return join(ws.docDir(slug), 'files') }
export function readIndex(ws: Workspace, slug: string): FileIndex {
  const p = join(filesDir(ws, slug), 'index.json')
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { files: [] } } catch { return { files: [] } }
}
export function writeIndex(ws: Workspace, slug: string, idx: FileIndex) {
  mkdirSync(filesDir(ws, slug), { recursive: true })
  writeFileSync(join(filesDir(ws, slug), 'index.json'), JSON.stringify(idx, null, 2))
}

function safeName(name: string) {
  return basename(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'file'
}

function csvToMarkdown(csv: string, maxRows = 400): string {
  const rows = csv.split(/\r?\n/).filter((r) => r.trim() !== '').slice(0, maxRows).map((r) => r.split(',').map((c) => c.trim().replace(/\|/g, '\\|')))
  if (!rows.length) return ''
  const w = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(w - r.length).fill('')]
  return [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(w).fill('---').join(' | ')} |`, ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`)].join('\n')
}

function stripRtf(rtf: string): string {
  // Control-word stripper: good enough for plain prose RTF.
  let s = rtf.replace(/\\par[d]?\b/g, '\n').replace(/\\tab\b/g, '\t').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\{\\\*[^{}]*\}/g, '')
  s = s.replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '')
  return s.replace(/\n{3,}/g, '\n\n').trim()
}

async function extractPptx(buffer: Buffer): Promise<string> {
  const req = createRequire(import.meta.url)
  const JSZip = req('jszip') // bundled with mammoth
  const zip = await JSZip.loadAsync(buffer)
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
  const out: string[] = []
  for (const n of names) {
    const xml: string = await zip.files[n].async('string')
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => [...m[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('')).filter(Boolean)
    out.push(`## Slide ${n.match(/\d+/)![0]}\n\n${paras.join('\n')}`)
  }
  return out.join('\n\n')
}

export interface Extracted { text: string; type: string; pages?: number; warning?: string }

export async function extract(name: string, buffer: Buffer): Promise<Extracted> {
  const ext = extname(name).toLowerCase()
  if (ext === '.docx') {
    const r = await (mammoth as any).convertToMarkdown({ buffer }) as { value: string; messages: { type: string; message: string }[] }
    return { text: r.value, type: 'docx', warning: r.messages.filter((m) => m.type === 'error').map((m) => m.message).join('; ') || undefined }
  }
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buffer })
    try {
      const r = await parser.getText()
      const pages = r.total ?? r.pages?.length
      const text = r.text ?? ''
      const perPage = pages ? text.replace(/\s+/g, '').length / pages : text.length
      const warning = pages && perPage < SCANNED_CHARS_PER_PAGE ? 'Little text found; likely scanned. Visual reading will be used.' : undefined
      return { text, type: 'pdf', pages, warning }
    } finally { await parser.destroy().catch(() => {}) }
  }
  if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.read(buffer, { type: 'buffer' })
    const parts = wb.SheetNames.map((s) => `## Sheet: ${s}\n\n${csvToMarkdown(XLSX.utils.sheet_to_csv(wb.Sheets[s]))}`)
    return { text: parts.join('\n\n'), type: 'xlsx' }
  }
  if (ext === '.csv') return { text: csvToMarkdown(buffer.toString('utf8')), type: 'csv' }
  if (ext === '.rtf') return { text: stripRtf(buffer.toString('latin1')), type: 'rtf' }
  if (ext === '.pptx') return { text: await extractPptx(buffer), type: 'pptx' }
  if (TEXT_EXT.has(ext)) return { text: buffer.toString('utf8'), type: ext.slice(1) || 'text' }
  if (ext === '.doc') throw new Error('Legacy .doc is not supported; save it as .docx first.')
  // Unknown: try as UTF-8 text if it looks like text.
  const sample = buffer.subarray(0, 4000)
  const printable = [...sample].filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128).length / Math.max(1, sample.length)
  if (printable > 0.95) return { text: buffer.toString('utf8'), type: 'text' }
  throw new Error(`Unsupported file type "${ext || 'none'}".`)
}

async function summarize(provider: Provider, name: string, text: string, model: string): Promise<string> {
  const head = text.slice(0, 60_000)
  const prompt = `Reference file: ${name} (${text.length.toLocaleString()} chars${text.length > head.length ? ', beginning shown' : ''}).\n\nWrite a compact outline of this file for another assistant that may later read the full file: 1 line describing what it is, then a bullet outline of its sections/topics with key facts, numbers and names (max ~300 words). Output only the outline.\n\n"""\n${head}\n"""`
  let out = ''
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 120_000)
  try {
    for await (const f of provider.oneShot({ system: 'You write compact, factual outlines. Output only the outline.', prompt, model, signal: ac.signal })) {
      if (f.type === 'text') out += f.text
    }
  } finally { clearTimeout(timer) }
  return out.trim()
}

/** Store the original, extract to files/extracted/<name>.md, record in index.json and meta.files. */
export async function ingest(ws: Workspace, slug: string, provider: Provider, originalName: string, buffer: Buffer, summaryModel = 'haiku'): Promise<FileEntry> {
  const dir = filesDir(ws, slug)
  mkdirSync(join(dir, 'original'), { recursive: true })
  mkdirSync(join(dir, 'extracted'), { recursive: true })
  let name = safeName(originalName)
  const base = name.replace(/(\.[^.]*)?$/, ''), ext = extname(name)
  for (let n = 2; existsSync(join(dir, 'original', name)); n++) name = `${base}-${n}${ext}`
  writeFileSync(join(dir, 'original', name), buffer)
  const entry: FileEntry = { name, type: ext.slice(1) || 'file', size: buffer.length, chars: 0, status: 'ok', addedAt: new Date().toISOString() }
  try {
    const ex = await extract(name, buffer)
    entry.type = ex.type
    entry.pages = ex.pages
    entry.chars = ex.text.length
    writeFileSync(join(dir, 'extracted', name + '.md'), ex.text)
    if (ex.warning) { entry.status = 'warning'; entry.warning = ex.warning }
    if (ex.text.length > INLINE_LIMIT) {
      try { entry.summary = await summarize(provider, name, ex.text, summaryModel) }
      catch (e: any) { entry.summary = undefined; entry.status = 'warning'; entry.warning = (entry.warning ? entry.warning + ' ' : '') + `Summary failed: ${e?.message ?? e}` }
    }
  } catch (e: any) {
    entry.status = 'error'
    entry.warning = e?.message ?? String(e)
    log.warn(`[ingest ${slug}] ${name}: ${entry.warning}`)
  }
  const idx = readIndex(ws, slug)
  idx.files = idx.files.filter((f) => f.name !== name).concat(entry)
  writeIndex(ws, slug, idx)
  const meta = ws.readMeta(slug)
  meta.files[name] = { enabled: entry.status !== 'error' }
  ws.updateMeta(slug, { files: meta.files })
  return entry
}

export function removeFile(ws: Workspace, slug: string, name: string) {
  const dir = filesDir(ws, slug)
  rmSync(join(dir, 'original', safeName(name)), { force: true })
  rmSync(join(dir, 'extracted', safeName(name) + '.md'), { force: true })
  const idx = readIndex(ws, slug)
  idx.files = idx.files.filter((f) => f.name !== name)
  writeIndex(ws, slug, idx)
  const meta = ws.readMeta(slug)
  delete meta.files[name]
  ws.updateMeta(slug, { files: meta.files })
}

/** Reference block for prompts: always the file list; small files inline; large files by path + cached outline. */
export function referenceBlock(ws: Workspace, slug: string, meta: DocMeta): { text: string; degraded: boolean; inlined: string[]; summarized: string[] } {
  const idx = readIndex(ws, slug)
  const enabled = idx.files.filter((f) => meta.files[f.name]?.enabled && f.status !== 'error')
  if (!enabled.length) return { text: '', degraded: false, inlined: [], summarized: [] }
  const dir = filesDir(ws, slug)
  const lines: string[] = ['## Reference files', '', 'Files the user attached to this document (paths are absolute; you may Read them):']
  const bodies: string[] = []
  let budget = INLINE_BUDGET
  let degraded = false
  const inlined: string[] = [], summarized: string[] = []
  // Pass 1: decide what fits.
  const plan = enabled.map((f) => {
    const small = f.chars <= INLINE_LIMIT
    return { f, small }
  })
  const totalSmall = plan.filter((p) => p.small).reduce((a, p) => a + p.f.chars, 0)
  if (totalSmall > budget) degraded = true
  for (const { f, small } of plan) {
    const extractedPath = join(dir, 'extracted', f.name + '.md')
    const originalPath = join(dir, 'original', f.name)
    const desc = (f.summary?.split('\n')[0] ?? '').slice(0, 120) || `${f.type} file`
    lines.push(`- ${f.name} — ${f.type}, ${(f.size / 1024).toFixed(0)} KB, ${f.chars.toLocaleString()} chars${f.pages ? `, ${f.pages} pages` : ''}${f.warning ? ` (note: ${f.warning})` : ''}: ${desc}`)
    let text = ''
    try { text = readFileSync(extractedPath, 'utf8') } catch {}
    if (small && !degraded && text.length <= budget) {
      budget -= text.length
      inlined.push(f.name)
      bodies.push(`### ${f.name} (full text)\n\n"""\n${text}\n"""`)
    } else {
      summarized.push(f.name)
      const extra = f.type === 'pdf' ? `\nOriginal PDF: ${originalPath} — you may Read it directly (visual) in page ranges of up to 20 pages if the extracted text is insufficient.` : ''
      bodies.push(`### ${f.name} (outline; full extracted text at ${extractedPath})${extra}\n\n${f.summary ?? text.slice(0, 1500) + (text.length > 1500 ? '\n…' : '')}`)
    }
  }
  if (degraded) lines.push('', '(Note: attached files exceed the inline budget; outlines are given instead of full text. Read the extracted files for details.)')
  return { text: [...lines, '', ...bodies].join('\n'), degraded, inlined, summarized }
}

export function fileStat(ws: Workspace, slug: string, name: string) {
  const p = join(filesDir(ws, slug), 'original', safeName(name))
  return existsSync(p) ? statSync(p) : null
}
