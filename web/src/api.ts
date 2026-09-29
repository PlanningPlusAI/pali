// Backend client. SSE over fetch (POST bodies), parsed by hand.

export type Frame =
  | { type: 'init'; sessionId: string; apiKeySource: string; model: string; tools: string[] }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: string; ok: boolean }
  | { type: 'rate_limit'; fiveHour?: number; sevenDay?: number; status?: string }
  | { type: 'done'; sessionId: string; text: string; isError: boolean; durationMs: number; costUsd?: number }
  | { type: 'error'; message: string }
  | { type: 'saved'; id: string }
  | { type: 'timing'; ttftMs: number; wallMs: number }

export interface Status {
  auth: null | { ok: boolean; usingApiKey: boolean; detail: string }
  cli: { cli: string; expected: string; ok: boolean }
  pool: { idle: number; size: number }
  chats: { key: string; proc: string; busy: boolean; sessionId: string | null }[]
  rateLimit: null | { fiveHour?: number; sevenDay?: number; status?: string }
  workspaceRoot: string | null
}

export interface DocMeta {
  slug: string
  title: string
  created: string
  updated: string
  tags: string[]
  instructions: string[]
  models: { chat: string; surgical: string }
  files: Record<string, { enabled: boolean }>
}

export interface DocSummary { slug: string; title: string; excerpt: string; created: string; updated: string }
export interface ChatEntry { id: string; ts: string; role: 'user' | 'assistant' | 'action' | 'system'; text: string; action?: unknown }
export interface InstructionSet { name: string; title: string; body: string; updated: string }
export interface AppConfig { workspaceRoot: string | null; defaultRoot: string; oneDriveRoot: string | null }
export interface FileEntry { name: string; type: string; size: number; chars: number; pages?: number; status: 'ok' | 'warning' | 'error'; warning?: string; summary?: string; addedAt: string; enabled?: boolean }
export interface FilesInfo { files: FileEntry[]; degraded: boolean; inlined: string[]; summarized: string[] }

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).error ?? msg } catch {}
    throw Object.assign(new Error(msg), { status: r.status })
  }
  return r.json()
}
const hdr = { 'content-type': 'application/json' }
export const api = {
  status: () => fetch('/api/status').then((r) => j<Status>(r)),
  config: () => fetch('/api/config').then((r) => j<AppConfig>(r)),
  setConfig: (workspaceRoot: string) => fetch('/api/config', { method: 'POST', headers: hdr, body: JSON.stringify({ workspaceRoot }) }).then((r) => j<{ workspaceRoot: string }>(r)),
  docs: (q?: string) => fetch('/api/docs' + (q ? `?q=${encodeURIComponent(q)}` : '')).then((r) => j<DocSummary[]>(r)),
  createDoc: (title: string) => fetch('/api/docs', { method: 'POST', headers: hdr, body: JSON.stringify({ title }) }).then((r) => j<{ meta: DocMeta }>(r)),
  doc: (slug: string) => fetch(`/api/docs/${slug}`).then((r) => j<{ meta: DocMeta; json: unknown | null; markdown: string }>(r)),
  saveContent: (slug: string, json: unknown, markdown: string, clientId: string) =>
    fetch(`/api/docs/${slug}/content`, { method: 'PUT', headers: hdr, body: JSON.stringify({ json, markdown, clientId }) }).then((r) => j<{ updated: string }>(r)),
  patchMeta: (slug: string, patch: Partial<DocMeta>) => fetch(`/api/docs/${slug}/meta`, { method: 'PATCH', headers: hdr, body: JSON.stringify(patch) }).then((r) => j<{ meta: DocMeta }>(r)),
  duplicateDoc: (slug: string) => fetch(`/api/docs/${slug}/duplicate`, { method: 'POST' }).then((r) => j<{ meta: DocMeta }>(r)),
  deleteDoc: (slug: string) => fetch(`/api/docs/${slug}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  reveal: (slug: string) => fetch(`/api/docs/${slug}/reveal`, { method: 'POST' }).then((r) => j<{ ok: true }>(r)),
  open: (slug: string, clientId: string) => fetch(`/api/docs/${slug}/open`, { method: 'POST', headers: hdr, body: JSON.stringify({ clientId }) }).then((r) => j<{ ok: boolean; readOnly: boolean; heldBy: string | null }>(r)),
  close: (slug: string, clientId: string) => fetch(`/api/docs/${slug}/close`, { method: 'POST', headers: hdr, body: JSON.stringify({ clientId }), keepalive: true }).catch(() => {}),
  chat: (slug: string) => fetch(`/api/docs/${slug}/chat`).then((r) => j<ChatEntry[]>(r)),
  clearChat: (slug: string) => fetch(`/api/docs/${slug}/chat`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  files: (slug: string) => fetch(`/api/docs/${slug}/files`).then((r) => j<FilesInfo>(r)),
  uploadFiles: (slug: string, files: File[]) => { const fd = new FormData(); for (const f of files) fd.append('file', f, f.name); return fetch(`/api/docs/${slug}/files`, { method: 'POST', body: fd }).then((r) => j<{ files: FileEntry[] }>(r)) },
  toggleFile: (slug: string, name: string, enabled: boolean) => fetch(`/api/docs/${slug}/files/${encodeURIComponent(name)}`, { method: 'PATCH', headers: hdr, body: JSON.stringify({ enabled }) }).then((r) => j<{ meta: DocMeta }>(r)),
  deleteFile: (slug: string, name: string) => fetch(`/api/docs/${slug}/files/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  snapshot: (slug: string, reason: string, json: unknown) => fetch(`/api/docs/${slug}/snapshot`, { method: 'POST', headers: hdr, body: JSON.stringify({ reason, json }) }).then((r) => j<{ ok: true }>(r)),
  addAction: (slug: string, text: string, action?: unknown) => fetch(`/api/docs/${slug}/actions`, { method: 'POST', headers: hdr, body: JSON.stringify({ text, action }) }).then((r) => j<ChatEntry>(r)),
  importDocx: (file: File) => { const fd = new FormData(); fd.append('file', file, file.name); return fetch('/api/import/docx', { method: 'POST', body: fd }).then((r) => j<{ title: string; html: string; warnings: string[] }>(r)) },
  exportDocx: async (slug: string, json: unknown) => {
    const r = await fetch(`/api/docs/${slug}/export/docx`, { method: 'POST', headers: hdr, body: JSON.stringify({ json }) })
    if (!r.ok) await j(r)
    return r.blob()
  },
  instructions: () => fetch('/api/instructions').then((r) => j<InstructionSet[]>(r)),
  saveInstruction: (name: string, body: string) => fetch(`/api/instructions/${encodeURIComponent(name)}`, { method: 'PUT', headers: hdr, body: JSON.stringify({ body }) }).then((r) => j<InstructionSet>(r)),
  deleteInstruction: (name: string) => fetch(`/api/instructions/${encodeURIComponent(name)}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  duplicateInstruction: (name: string) => fetch(`/api/instructions/${encodeURIComponent(name)}/duplicate`, { method: 'POST' }).then((r) => j<InstructionSet>(r)),
}

/** POST and stream SSE frames. Resolves when the stream ends. */
export async function streamSse(path: string, body: unknown, onFrame: (f: Frame) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: hdr, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const m = /^event: (\w+)\ndata: ([\s\S]*)$/.exec(chunk)
      if (!m) continue
      try { onFrame(JSON.parse(m[2])) } catch { /* ignore malformed */ }
    }
  }
}

export const clientId = (() => {
  try {
    const k = 'canvas-client-id'
    let v = sessionStorage.getItem(k)
    if (!v) { v = Math.random().toString(36).slice(2, 10); sessionStorage.setItem(k, v) }
    return v
  } catch { return Math.random().toString(36).slice(2, 10) }
})()
