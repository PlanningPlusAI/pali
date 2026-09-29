import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { log } from './log.js'
import { SURGICAL_CONTRACT } from './prompts.js'
import { ClaudeProvider } from './provider/claude/adapter.js'
import { registerRoutes, type AppState } from './routes.js'
import { OpenMarkers, Workspace } from './workspace.js'

const PORT = Number(process.env.CANVAS_PORT ?? 5199)
const provider = new ClaudeProvider(2)

const cfg = loadConfig()
let ws: Workspace | null = null
if (cfg.workspaceRoot) {
  try { ws = new Workspace(cfg.workspaceRoot); ws.ensureLayout(); log.info(`workspace: ${ws.root}`) }
  catch (e) { log.warn(`workspace ${cfg.workspaceRoot} unusable: ${e}`) }
}

const state: AppState = { provider, ws, markers: new OpenMarkers(), auth: null, cli: provider.cliVersionCheck(), promptLog: [] }

const app = Fastify({ logger: false, bodyLimit: 50 * 1024 * 1024 })
registerRoutes(app, state)

app.post('/api/shutdown', async () => { setTimeout(() => shutdown('api'), 50); return { ok: true } })

// Serve the built frontend (web/dist) when present, so the launcher needs only this process.
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist')
if (existsSync(join(distDir, 'index.html'))) {
  app.register(fastifyStatic, { root: distDir, prefix: '/' })
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'not found' })
    return reply.sendFile('index.html')
  })
  log.info(`serving UI from ${distDir}`)
}

async function main() {
  if (!state.cli.ok) log.warn(`CLI version ${state.cli.cli} != SDK manifest ${state.cli.expected}`)
  await app.listen({ port: PORT, host: '127.0.0.1' })
  log.info(`Canvas backend on http://127.0.0.1:${PORT}`)
  // Boot-time auth probe (GOAL §2): loud banner if not on subscription, never fatal.
  provider.probeAuth().then((a) => {
    state.auth = a
    if (a.usingApiKey || !a.ok) log.warn(`AUTH PROBE: ${JSON.stringify(a)} — UI banner will show`)
    else log.info(`auth probe ok: ${a.detail}`)
    provider.warm('sonnet', SURGICAL_CONTRACT)
  }).catch((e) => { state.auth = { ok: false, usingApiKey: false, detail: String(e) } })
}

let shuttingDown = false
async function shutdown(sig: string) {
  if (shuttingDown) return
  shuttingDown = true
  log.info(`${sig}: shutting down, killing child processes`)
  await provider.shutdown()
  await app.close()
  process.exit(0)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))

main().catch((e) => { log.error(e); process.exit(1) })
