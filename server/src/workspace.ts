// Folders are the database (GOAL §6). Everything here is plain fs.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, cpSync, appendFileSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface DocMeta {
  slug: string
  title: string
  created: string
  updated: string
  tags: string[]
  instructions: string[] // attached instruction set names, in prompt order
  models: { chat: string; surgical: string }
  files: Record<string, { enabled: boolean }>
}

export interface DocSummary {
  slug: string
  title: string
  excerpt: string
  created: string
  updated: string
}

export interface ChatEntry {
  id: string
  ts: string
  role: 'user' | 'assistant' | 'action' | 'system'
  text: string
  action?: unknown
}

export interface InstructionSet {
  name: string
  title: string
  body: string
  updated: string
}

export interface SessionInfo {
  sessionId: string
  model: string
  systemHash: string
  createdAt: string
}

const RESERVED = new Set(['instructions', '.trash', 'config.json'])

export function slugify(title: string) {
  const s = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return s || 'untitled'
}

export class Workspace {
  constructor(public root: string) {}

  ensureLayout() {
    mkdirSync(this.root, { recursive: true })
    mkdirSync(join(this.root, 'instructions'), { recursive: true })
    mkdirSync(join(this.root, '.trash'), { recursive: true })
    const cfg = join(this.root, 'config.json')
    if (!existsSync(cfg)) writeFileSync(cfg, JSON.stringify({ defaultModels: { chat: 'sonnet', surgical: 'sonnet' } }, null, 2))
  }

  workspaceConfig(): { defaultModels: { chat: string; surgical: string } } {
    try { return { defaultModels: { chat: 'sonnet', surgical: 'sonnet' }, ...JSON.parse(readFileSync(join(this.root, 'config.json'), 'utf8')) } }
    catch { return { defaultModels: { chat: 'sonnet', surgical: 'sonnet' } } }
  }

  // ---------- documents ----------

  docDir(slug: string) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) || RESERVED.has(slug)) throw new Error(`bad slug: ${slug}`)
    return join(this.root, slug)
  }

  private isDocDir(p: string) {
    return existsSync(join(p, 'meta.json'))
  }

  /** Scan: any folder with meta.json is a document. Folders dropped in by hand appear too. */
  listDocs(query?: string): DocSummary[] {
    const out: DocSummary[] = []
    for (const name of readdirSync(this.root)) {
      if (RESERVED.has(name) || name.startsWith('.')) continue
      const p = join(this.root, name)
      try { if (!statSync(p).isDirectory() || !this.isDocDir(p)) continue } catch { continue }
      const meta = this.readMeta(name)
      const md = this.readMarkdown(name)
      const excerpt = md.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l !== '$$').slice(0, 1).join(' ')
        .replace(/[*_`~]+/g, '').replace(/^[-*+]\s+|^\d+\.\s+|^>\s*/, '').slice(0, 140)
      if (query) {
        const q = query.toLowerCase()
        if (!meta.title.toLowerCase().includes(q) && !md.toLowerCase().includes(q)) continue
      }
      out.push({ slug: meta.slug, title: meta.title, excerpt, created: meta.created, updated: meta.updated })
    }
    out.sort((a, b) => (a.updated < b.updated ? 1 : -1))
    return out
  }

  readMeta(slug: string): DocMeta {
    const raw = JSON.parse(readFileSync(join(this.docDir(slug), 'meta.json'), 'utf8'))
    const defaults = this.workspaceConfig().defaultModels
    return {
      slug,
      title: raw.title ?? slug,
      created: raw.created ?? new Date().toISOString(),
      updated: raw.updated ?? new Date().toISOString(),
      tags: raw.tags ?? [],
      instructions: raw.instructions ?? [],
      models: { ...defaults, ...(raw.models ?? {}) },
      files: raw.files ?? {},
    }
  }

  writeMeta(slug: string, meta: DocMeta) {
    const { slug: _s, ...rest } = meta
    writeFileSync(join(this.docDir(slug), 'meta.json'), JSON.stringify(rest, null, 2))
  }

  readJson(slug: string): unknown | null {
    const p = join(this.docDir(slug), 'document.json')
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  }

  readMarkdown(slug: string): string {
    const p = join(this.docDir(slug), 'document.md')
    return existsSync(p) ? readFileSync(p, 'utf8') : ''
  }

  private uniqueSlug(base: string) {
    let slug = base
    let n = 2
    while (existsSync(join(this.root, slug)) || RESERVED.has(slug)) slug = `${base}-${n++}`
    return slug
  }

  createDoc(title: string, opts?: { json?: unknown; markdown?: string; instructions?: string[] }): DocMeta {
    const slug = this.uniqueSlug(slugify(title))
    const dir = join(this.root, slug)
    mkdirSync(join(dir, 'files', 'original'), { recursive: true })
    mkdirSync(join(dir, 'files', 'extracted'), { recursive: true })
    mkdirSync(join(dir, 'history'), { recursive: true })
    const now = new Date().toISOString()
    const meta: DocMeta = {
      slug, title: title.trim() || 'Untitled', created: now, updated: now, tags: [],
      instructions: opts?.instructions ?? [], models: this.workspaceConfig().defaultModels, files: {},
    }
    this.writeMeta(slug, meta)
    writeFileSync(join(dir, 'document.json'), JSON.stringify(opts?.json ?? { type: 'doc', content: [{ type: 'paragraph' }] }, null, 2))
    writeFileSync(join(dir, 'document.md'), opts?.markdown ?? '')
    writeFileSync(join(dir, 'chat.jsonl'), '')
    writeFileSync(join(dir, 'files', 'index.json'), JSON.stringify({ files: [] }, null, 2))
    return meta
  }

  saveContent(slug: string, json: unknown, markdown: string): DocMeta {
    const dir = this.docDir(slug)
    writeFileSync(join(dir, 'document.json'), JSON.stringify(json, null, 2))
    writeFileSync(join(dir, 'document.md'), markdown)
    const meta = this.readMeta(slug)
    meta.updated = new Date().toISOString()
    this.writeMeta(slug, meta)
    this.periodicSnapshot(slug, json)
    return meta
  }

  private lastSnapshot = new Map<string, number>()
  private periodicSnapshot(slug: string, json: unknown) {
    const last = this.lastSnapshot.get(slug) ?? 0
    if (Date.now() - last < 5 * 60_000) return
    this.snapshot(slug, 'periodic', json)
  }

  /** history/<ts>-<reason>.json */
  snapshot(slug: string, reason: string, json?: unknown) {
    const dir = join(this.docDir(slug), 'history')
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(dir, `${ts}-${reason.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.json`), JSON.stringify(json ?? this.readJson(slug), null, 2))
    this.lastSnapshot.set(slug, Date.now())
  }

  updateMeta(slug: string, patch: Partial<Pick<DocMeta, 'title' | 'instructions' | 'models' | 'files' | 'tags'>>): DocMeta {
    const meta = this.readMeta(slug)
    if (patch.title !== undefined) meta.title = patch.title.trim() || meta.title
    if (patch.instructions !== undefined) meta.instructions = patch.instructions
    if (patch.models !== undefined) meta.models = { ...meta.models, ...patch.models }
    if (patch.files !== undefined) meta.files = patch.files
    if (patch.tags !== undefined) meta.tags = patch.tags
    meta.updated = new Date().toISOString()
    this.writeMeta(slug, meta)
    return meta
  }

  duplicateDoc(slug: string): DocMeta {
    const src = this.docDir(slug)
    const meta = this.readMeta(slug)
    const newSlug = this.uniqueSlug(slugify(meta.title + ' copy'))
    const dst = join(this.root, newSlug)
    cpSync(src, dst, { recursive: true })
    // The copy gets a fresh chat + session (isolation: sessions are never shared).
    writeFileSync(join(dst, 'chat.jsonl'), '')
    rmSync(join(dst, 'session.json'), { force: true })
    const now = new Date().toISOString()
    const m2: DocMeta = { ...meta, slug: newSlug, title: meta.title + ' (copy)', created: now, updated: now }
    this.writeMeta(newSlug, m2)
    return m2
  }

  trashDoc(slug: string) {
    const src = this.docDir(slug)
    const trash = join(this.root, '.trash')
    mkdirSync(trash, { recursive: true })
    let dst = join(trash, slug)
    let n = 2
    while (existsSync(dst)) dst = join(trash, `${slug}-${n++}`)
    // Windows can hold a transient lock (indexer, Explorer, a just-finished copy): retry briefly.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(src, dst); break }
      catch (e: any) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e
        const until = Date.now() + 150 * (attempt + 1)
        while (Date.now() < until) { /* short sync wait */ }
      }
    }
    return dst
  }

  // ---------- chat transcript ----------

  readChat(slug: string): ChatEntry[] {
    const p = join(this.docDir(slug), 'chat.jsonl')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  }

  appendChat(slug: string, entry: Omit<ChatEntry, 'id' | 'ts'> & Partial<Pick<ChatEntry, 'id' | 'ts'>>): ChatEntry {
    const e: ChatEntry = { id: entry.id ?? randomUUID(), ts: entry.ts ?? new Date().toISOString(), ...entry } as ChatEntry
    appendFileSync(join(this.docDir(slug), 'chat.jsonl'), JSON.stringify(e) + '\n')
    return e
  }

  clearChat(slug: string) {
    writeFileSync(join(this.docDir(slug), 'chat.jsonl'), '')
  }

  readSession(slug: string): SessionInfo | null {
    const p = join(this.docDir(slug), 'session.json')
    if (!existsSync(p)) return null
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  }

  writeSession(slug: string, s: SessionInfo | null) {
    const p = join(this.docDir(slug), 'session.json')
    if (!s) rmSync(p, { force: true })
    else writeFileSync(p, JSON.stringify(s, null, 2))
  }

  // ---------- instruction library (GOAL §9) ----------

  private instrDir() { return join(this.root, 'instructions') }

  private instrName(name: string) {
    const n = name.trim().replace(/\.md$/i, '')
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(n)) throw new Error(`bad instruction name: ${name}`)
    return n
  }

  listInstructions(): InstructionSet[] {
    const dir = this.instrDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => this.readInstruction(basename(f, '.md'))).filter((x): x is InstructionSet => !!x)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  readInstruction(name: string): InstructionSet | null {
    const p = join(this.instrDir(), this.instrName(name) + '.md')
    if (!existsSync(p)) return null
    const body = readFileSync(p, 'utf8')
    const first = body.split('\n')[0]?.trim() ?? ''
    const title = first.startsWith('#') ? first.replace(/^#+\s*/, '') : name
    return { name: this.instrName(name), title, body, updated: statSync(p).mtime.toISOString() }
  }

  writeInstruction(name: string, body: string): InstructionSet {
    const n = this.instrName(name)
    mkdirSync(this.instrDir(), { recursive: true })
    writeFileSync(join(this.instrDir(), n + '.md'), body)
    return this.readInstruction(n)!
  }

  deleteInstruction(name: string) {
    rmSync(join(this.instrDir(), this.instrName(name) + '.md'), { force: true })
  }

  duplicateInstruction(name: string): InstructionSet {
    const src = this.readInstruction(name)
    if (!src) throw new Error('not found')
    let n = 2
    let newName = `${src.name} copy`
    while (existsSync(join(this.instrDir(), newName + '.md'))) newName = `${src.name} copy ${n++}`
    return this.writeInstruction(newName, src.body)
  }

  /** Build the "Standing instructions" block for a document (GOAL §9 precedence text). */
  standingInstructions(names: string[]): string {
    const parts: string[] = []
    for (const name of names) {
      const s = this.readInstruction(name)
      if (s) parts.push(`### ${s.title}\n\n${s.body.replace(/^#.*\n/, '').trim()}`)
    }
    if (!parts.length) return ''
    return (
      '## Standing instructions from the user\n\n' +
      "The user's message for this turn takes precedence over standing instructions where they conflict; otherwise standing instructions always apply.\n\n" +
      parts.join('\n\n')
    )
  }
}

/** One writer per document — in-memory only, expires without heartbeat (GOAL §6). */
export class OpenMarkers {
  private marks = new Map<string, { clientId: string; ts: number }>()
  private ttl = 45_000
  claim(slug: string, clientId: string): { ok: boolean; heldBy?: string } {
    const m = this.marks.get(slug)
    if (m && m.clientId !== clientId && Date.now() - m.ts < this.ttl) return { ok: false, heldBy: m.clientId }
    this.marks.set(slug, { clientId, ts: Date.now() })
    return { ok: true }
  }
  release(slug: string, clientId: string) {
    const m = this.marks.get(slug)
    if (m && m.clientId === clientId) this.marks.delete(slug)
  }
  holder(slug: string) {
    const m = this.marks.get(slug)
    return m && Date.now() - m.ts < this.ttl ? m.clientId : null
  }
}
