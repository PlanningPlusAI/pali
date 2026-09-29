import type { FastifyInstance } from 'fastify'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_WORKSPACE, ONEDRIVE_DOCUMENTS, loadConfig, saveConfig } from './config.js'
import { log } from './log.js'
import type { ClaudeProvider } from './provider/claude/adapter.js'
import { chatSystem, surgicalSystem } from './prompts.js'
import { openSse } from './sse.js'
import { CHAT_TOOLS_GUIDE, makeDocTools, renderDocument, type Block, type TurnContext } from './doctools.js'
import type { CustomTool } from './provider/types.js'
import { runEdit } from './surgical.js'
import multipart from '@fastify/multipart'
import { ingest, readIndex, referenceBlock as buildReferenceBlock, removeFile } from './ingest.js'
import { OpenMarkers, Workspace, type DocMeta } from './workspace.js'
import { exportDocx, importDocx } from './wordio.js'

/** Reference-file block for prompts (GOAL §8). */
function referenceBlock(ws: Workspace, slug: string, meta: DocMeta): string {
  return buildReferenceBlock(ws, slug, meta).text
}

export interface AppState {
  provider: ClaudeProvider
  ws: Workspace | null
  markers: OpenMarkers
  auth: null | { ok: boolean; usingApiKey: boolean; detail: string }
  cli: { cli: string; expected: string; ok: boolean }
  /** Last prompts sent per document, for the isolation test + debugging (GOAL §6). */
  promptLog: { ts: string; slug: string; lane: 'chat' | 'surgical'; system: string; prompt: string }[]
}

// Phase 6 verified (spike/resume-test.ts): resume with identical options works; it also tolerates a
// changed system prompt/model/tools, but we still start a fresh session on instruction-set changes (GOAL §9).
const STARTED_AT = new Date().toISOString()
const RESUME_ENABLED = process.env.CANVAS_RESUME !== '0'
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12)

function need(state: AppState): Workspace {
  if (!state.ws) throw Object.assign(new Error('workspace not configured'), { statusCode: 409 })
  return state.ws
}

export function registerRoutes(app: FastifyInstance, state: AppState) {
  app.setErrorHandler((err: any, _req, reply) => {
    const code = err.statusCode ?? (String(err.message).includes('ENOENT') ? 404 : 500)
    if (code >= 500) log.error(err)
    reply.code(code).send({ error: err.message ?? String(err) })
  })

  // ---------- status / config ----------

  app.get('/api/status', async () => ({
    auth: state.auth,
    cli: state.cli,
    pool: state.provider.poolStats,
    chats: state.provider.chatStats,
    rateLimit: state.provider.lastRateLimit,
    workspaceRoot: state.ws?.root ?? null,
    startedAt: STARTED_AT, // the launcher restarts the backend when server sources are newer
  }))

  app.get('/api/models', async () => state.provider.listModels())

  app.get('/api/config', async () => ({
    workspaceRoot: state.ws?.root ?? null,
    defaultRoot: DEFAULT_WORKSPACE,
    oneDriveRoot: ONEDRIVE_DOCUMENTS,
  }))

  app.post<{ Body: { workspaceRoot: string } }>('/api/config', async (req) => {
    const root = resolve(String(req.body?.workspaceRoot ?? '').trim())
    if (!root || root.length < 3) throw Object.assign(new Error('workspaceRoot required'), { statusCode: 400 })
    const ws = new Workspace(root)
    ws.ensureLayout()
    state.ws = ws
    saveConfig({ ...loadConfig(), workspaceRoot: root })
    log.info(`workspace set to ${root}`)
    return { workspaceRoot: root }
  })

  // ---------- documents ----------

  app.get<{ Querystring: { q?: string } }>('/api/docs', async (req) => need(state).listDocs(req.query?.q))

  app.post<{ Body: { title?: string } }>('/api/docs', async (req) => {
    const meta = need(state).createDoc(req.body?.title ?? 'Untitled')
    return { meta }
  })

  app.get<{ Params: { slug: string } }>('/api/docs/:slug', async (req) => {
    const ws = need(state)
    const meta = ws.readMeta(req.params.slug)
    return { meta, json: ws.readJson(req.params.slug), markdown: ws.readMarkdown(req.params.slug), session: ws.readSession(req.params.slug) }
  })

  app.put<{ Params: { slug: string }; Body: { json: unknown; markdown: string; clientId?: string } }>('/api/docs/:slug/content', async (req) => {
    const ws = need(state)
    const holder = state.markers.holder(req.params.slug)
    if (holder && req.body.clientId && holder !== req.body.clientId) throw Object.assign(new Error('document is open read-only in this tab'), { statusCode: 423 })
    if (req.body.clientId) state.markers.claim(req.params.slug, req.body.clientId) // heartbeat
    const meta = ws.saveContent(req.params.slug, req.body.json, String(req.body.markdown ?? ''))
    return { updated: meta.updated }
  })

  app.patch<{ Params: { slug: string }; Body: any }>('/api/docs/:slug/meta', async (req) => {
    const ws = need(state)
    const before = ws.readMeta(req.params.slug)
    const meta = ws.updateMeta(req.params.slug, req.body ?? {})
    // GOAL §9: changing attached instruction sets starts a fresh chat session.
    if ((req.body as any)?.instructions && JSON.stringify(before.instructions) !== JSON.stringify(meta.instructions)) {
      await state.provider.endChat(req.params.slug)
      ws.writeSession(req.params.slug, null)
      ws.appendChat(req.params.slug, { role: 'system', text: `Instruction sets changed (${meta.instructions.join(', ') || 'none'}). A new chat session starts with the next message; the transcript above is kept.` })
    }
    return { meta }
  })

  app.post<{ Params: { slug: string } }>('/api/docs/:slug/duplicate', async (req) => ({ meta: need(state).duplicateDoc(req.params.slug) }))

  app.delete<{ Params: { slug: string } }>('/api/docs/:slug', async (req) => {
    await state.provider.endChat(req.params.slug)
    const dst = need(state).trashDoc(req.params.slug)
    return { ok: true, movedTo: dst }
  })

  app.post<{ Params: { slug: string } }>('/api/docs/:slug/reveal', async (req) => {
    const dir = need(state).docDir(req.params.slug)
    execFile('explorer.exe', [dir])
    return { ok: true }
  })

  app.post<{ Params: { slug: string }; Body: { clientId: string } }>('/api/docs/:slug/open', async (req) => {
    need(state).readMeta(req.params.slug) // 404 if missing
    const r = state.markers.claim(req.params.slug, String(req.body?.clientId ?? ''))
    return { ok: r.ok, readOnly: !r.ok, heldBy: r.heldBy ?? null }
  })

  app.post<{ Params: { slug: string }; Body: { clientId: string } }>('/api/docs/:slug/close', async (req) => {
    state.markers.release(req.params.slug, String(req.body?.clientId ?? ''))
    return { ok: true }
  })

  app.get<{ Params: { slug: string } }>('/api/docs/:slug/history', async (req) => {
    const dir = join(need(state).docDir(req.params.slug), 'history')
    const { readdirSync } = await import('node:fs')
    return existsSync(dir) ? readdirSync(dir).sort().reverse() : []
  })

  // ---------- instruction library ----------

  app.get('/api/instructions', async () => need(state).listInstructions())
  app.put<{ Params: { name: string }; Body: { body: string } }>('/api/instructions/:name', async (req) => need(state).writeInstruction(req.params.name, String(req.body?.body ?? '')))
  app.delete<{ Params: { name: string } }>('/api/instructions/:name', async (req) => { need(state).deleteInstruction(req.params.name); return { ok: true } })
  app.post<{ Params: { name: string } }>('/api/instructions/:name/duplicate', async (req) => need(state).duplicateInstruction(req.params.name))

  // ---------- chat lane (per document) ----------

  app.get<{ Params: { slug: string } }>('/api/docs/:slug/chat', async (req) => need(state).readChat(req.params.slug))

  app.delete<{ Params: { slug: string } }>('/api/docs/:slug/chat', async (req) => {
    const ws = need(state)
    await state.provider.endChat(req.params.slug)
    ws.writeSession(req.params.slug, null)
    ws.clearChat(req.params.slug)
    return { ok: true }
  })

  // Per-document tool context: tools are created once per conversation (the process holds them),
  // the context is refreshed every turn with the blocks the frontend sends.
  const toolCtx = new Map<string, { ctx: TurnContext; tools: CustomTool[] }>()
  const getTools = (slug: string) => {
    let t = toolCtx.get(slug)
    if (!t) { const ctx: TurnContext = { blocks: [], emit: () => {}, newSeq: 0, edits: 0 }; t = { ctx, tools: makeDocTools(ctx) }; toolCtx.set(slug, t) }
    return t
  }

  app.post<{ Params: { slug: string }; Body: { prompt: string; markdown?: string; blocks?: Block[]; model?: string; highlighted?: { text: string; label: string; blockId: string } | null } }>('/api/docs/:slug/chat', async (req, reply) => {
    const ws = need(state)
    const slug = req.params.slug
    const meta = ws.readMeta(slug)
    const prompt = String(req.body?.prompt ?? '').trim()
    if (!prompt) return reply.code(400).send({ error: 'prompt required' })
    const model = req.body?.model ?? meta.models.chat
    const system = chatSystem(ws.standingInstructions(meta.instructions), CHAT_TOOLS_GUIDE)
    // Blocks with ids from the frontend (fresh every turn); fall back to the markdown mirror on disk.
    const blocks: Block[] = Array.isArray(req.body?.blocks) && req.body!.blocks!.length
      ? req.body!.blocks!.map((b, i) => ({ id: String(b.id ?? `b${i + 1}`), md: String(b.md ?? '') }))
      : (req.body?.markdown ?? ws.readMarkdown(slug)).split(/\n\s*\n/).filter(Boolean).map((md, i) => ({ id: `b${i + 1}`, md }))
    const files = referenceBlock(ws, slug, meta)
    // Isolation (GOAL §6): exactly this document's text + attached instruction sets + this document's files.
    const hl = req.body?.highlighted
    const hlBlock = hl?.text
      ? `\n\n---\nHighlighted text: the user has highlighted this span in block [${hl.blockId}] (${hl.label}); their message refers to it. To change it, edit that block with the tools and keep the rest of the block intact:\n"""\n${String(hl.text).slice(0, 20000)}\n"""`
      : ''
    const userMessage = `${prompt}${hlBlock}\n\n---\nCurrent document (markdown, one block per [id]):\n\n${renderDocument(blocks)}${files ? `\n\n---\n${files}` : ''}`
    state.promptLog.push({ ts: new Date().toISOString(), slug, lane: 'chat', system, prompt: userMessage })
    if (state.promptLog.length > 200) state.promptLog.shift()

    const prev = ws.readSession(slug)
    const sysHash = hash(system)
    // Resume is gated until Phase 6 verifies identical-option resume (GOAL §6/§10).
    const resumeId = RESUME_ENABLED && prev && prev.model === model && prev.systemHash === sysHash ? prev.sessionId : undefined
    ws.appendChat(slug, { role: 'user', text: hl?.text ? `${prompt}\n\n▸ highlighted (${hl.label}): “${hl.text.length > 160 ? hl.text.slice(0, 160) + '…' : hl.text}”` : prompt })
    const sse = openSse(req, reply)
    const { ctx, tools } = getTools(slug)
    ctx.blocks = blocks
    ctx.newSeq = 0
    ctx.edits = 0
    ctx.emit = (e) => { log.info(`[chat ${slug}] doc_edit ${e.op} ${e.fromId ?? ''}${e.toId ? '–' + e.toId : ''}`); sse.send('doc_edit', e) }
    let text = ''
    try {
      for await (const f of state.provider.chat({
        system, prompt: userMessage, model, cwd: ws.docDir(slug), conversationKey: slug, sessionId: resumeId, tools, signal: sse.signal,
      })) {
        if (f.type === 'text') text += f.text
        sse.send(f.type, f)
        if (f.type === 'init') ws.writeSession(slug, { sessionId: f.sessionId, model, systemHash: sysHash, createdAt: new Date().toISOString() })
        if (f.type === 'done') {
          const e = ws.appendChat(slug, { role: 'assistant', text: f.text || text })
          sse.send('saved', { id: e.id })
        }
      }
    } catch (e: any) {
      sse.send('error', { type: 'error', message: e?.message ?? String(e) })
    } finally {
      ctx.emit = () => {}
      if (sse.signal.aborted && text) ws.appendChat(slug, { role: 'assistant', text: text + ' …(stopped)' })
      sse.close()
    }
  })

  // ---------- surgical lane (Phase 3 fills in validation/apply; endpoint exists now for warm-up) ----------

  app.post<{ Params: { slug: string }; Body: { prompt: string; model?: string; useInstructions?: boolean } }>('/api/docs/:slug/oneshot', async (req, reply) => {
    const ws = need(state)
    const slug = req.params.slug
    const meta = ws.readMeta(slug)
    const model = req.body?.model ?? meta.models.surgical
    const system = surgicalSystem(req.body?.useInstructions === false ? '' : ws.standingInstructions(meta.instructions))
    state.promptLog.push({ ts: new Date().toISOString(), slug, lane: 'surgical', system, prompt: req.body.prompt })
    const sse = openSse(req, reply)
    try {
      for await (const f of state.provider.oneShot({ system, prompt: String(req.body?.prompt ?? ''), model, signal: sse.signal })) sse.send(f.type, f)
    } catch (e: any) {
      sse.send('error', { type: 'error', message: e?.message ?? String(e) })
    } finally {
      sse.close()
    }
  })

  /** Surgical edit (GOAL §7): validated one-shot; frontend applies the splice. */
  app.post<{ Params: { slug: string }; Body: { selection: string; context: string; instruction: string; kind: 'inline' | 'block'; maxRatio?: number; model?: string; useInstructions?: boolean; useFiles?: boolean } }>('/api/docs/:slug/edit', async (req, reply) => {
    const ws = need(state)
    const slug = req.params.slug
    const meta = ws.readMeta(slug)
    const b = req.body ?? ({} as any)
    if (!b.selection || !b.instruction || !b.kind) return reply.code(400).send({ error: 'selection, instruction, kind required' })
    const sse = openSse(req, reply)
    const t0 = Date.now()
    try {
      const result = await runEdit(state.provider, {
        selection: String(b.selection), context: String(b.context ?? b.selection), instruction: String(b.instruction), kind: b.kind, maxRatio: b.maxRatio,
        model: b.model ?? meta.models.surgical,
        standing: b.useInstructions === false ? '' : ws.standingInstructions(meta.instructions),
        files: b.useFiles ? referenceBlock(ws, slug, meta) : undefined,
        signal: sse.signal,
      }, (t, attempt) => sse.send('text', { type: 'text', text: t, attempt }), (system, prompt) => {
        state.promptLog.push({ ts: new Date().toISOString(), slug, lane: 'surgical', system, prompt })
        if (state.promptLog.length > 200) state.promptLog.shift()
      })
      log.info(`[edit ${slug}] ${result.ok ? 'ok' : 'REJECTED: ' + result.reason} in ${Date.now() - t0}ms (${result.attempts} attempt${result.attempts > 1 ? 's' : ''})`)
      sse.send('result', { type: 'result', ...result, wallMs: Date.now() - t0 })
    } catch (e: any) {
      sse.send('error', { type: 'error', message: e?.message ?? String(e) })
    } finally {
      sse.close()
    }
  })

  /** Snapshot the pre-edit state into history/ (one per AI edit). */
  app.post<{ Params: { slug: string }; Body: { reason: string; json: unknown } }>('/api/docs/:slug/snapshot', async (req) => {
    need(state).snapshot(req.params.slug, String(req.body?.reason ?? 'manual'), req.body?.json)
    return { ok: true }
  })

  /** Append an action record (✎ …) to the transcript. */
  app.post<{ Params: { slug: string }; Body: { text: string; action?: unknown } }>('/api/docs/:slug/actions', async (req) => {
    return need(state).appendChat(req.params.slug, { role: 'action', text: String(req.body?.text ?? ''), action: req.body?.action })
  })

  // ---------- ingestion (GOAL §8) ----------

  app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 20 } })

  app.get<{ Params: { slug: string } }>('/api/docs/:slug/files', async (req) => {
    const ws = need(state)
    const meta = ws.readMeta(req.params.slug)
    const idx = readIndex(ws, req.params.slug)
    const ref = buildReferenceBlock(ws, req.params.slug, meta)
    return { files: idx.files.map((f) => ({ ...f, enabled: !!meta.files[f.name]?.enabled })), degraded: ref.degraded, inlined: ref.inlined, summarized: ref.summarized }
  })

  app.post<{ Params: { slug: string } }>('/api/docs/:slug/files', async (req) => {
    const ws = need(state)
    const slug = req.params.slug
    ws.readMeta(slug)
    const out: unknown[] = []
    for await (const part of req.files()) {
      const buf = await part.toBuffer()
      const t0 = Date.now()
      const entry = await ingest(ws, slug, state.provider, part.filename, buf, 'haiku')
      log.info(`[ingest ${slug}] ${entry.name}: ${entry.status} ${entry.chars} chars${entry.pages ? ` ${entry.pages} pages` : ''}${entry.summary ? ' +summary' : ''} in ${Date.now() - t0}ms${entry.warning ? ` — ${entry.warning}` : ''}`)
      out.push(entry)
    }
    return { files: out }
  })

  app.patch<{ Params: { slug: string; name: string }; Body: { enabled: boolean } }>('/api/docs/:slug/files/:name', async (req) => {
    const ws = need(state)
    const meta = ws.readMeta(req.params.slug)
    if (!(req.params.name in meta.files)) throw Object.assign(new Error('no such file'), { statusCode: 404 })
    meta.files[req.params.name] = { enabled: !!req.body?.enabled }
    return { meta: ws.updateMeta(req.params.slug, { files: meta.files }) }
  })

  app.delete<{ Params: { slug: string; name: string } }>('/api/docs/:slug/files/:name', async (req) => {
    removeFile(need(state), req.params.slug, req.params.name)
    return { ok: true }
  })

  // ---------- Word import / export ----------

  /** Convert a .docx to HTML; the frontend parses it with the editor schema and creates the document. */
  app.post('/api/import/docx', async (req, reply) => {
    const part = await req.file()
    if (!part) return reply.code(400).send({ error: 'file required' })
    if (!/\.docx$/i.test(part.filename)) return reply.code(400).send({ error: 'Only .docx files can be imported (save legacy .doc as .docx first).' })
    const r = await importDocx(part.filename, await part.toBuffer())
    log.info(`[import] ${part.filename}: ${r.html.length} chars html${r.warnings.length ? ` — ${r.warnings.join(' ')}` : ''}`)
    return r
  })

  /** Export the live editor JSON (sent by the client, so unsaved keystrokes are included). */
  app.post<{ Params: { slug: string }; Body: { json: unknown } }>('/api/docs/:slug/export/docx', async (req, reply) => {
    const meta = need(state).readMeta(req.params.slug)
    const buf = await exportDocx(req.body?.json, meta.title)
    const name = (meta.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document') + '.docx'
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    reply.header('content-disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    return reply.send(buf)
  })

  /** What the next prompt would contain from files (for the UI + tests). */
  app.get<{ Params: { slug: string } }>('/api/docs/:slug/files/preview', async (req) => {
    const ws = need(state)
    return buildReferenceBlock(ws, req.params.slug, ws.readMeta(req.params.slug))
  })

  app.get('/api/debug/prompts', async () => state.promptLog)
}
