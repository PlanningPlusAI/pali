import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ChatRequest, CustomTool, Frame, OneShotRequest, Provider } from '../types.js'
import { ClaudeProcess, type ProcessSpec } from './process.js'
import { log } from '../../log.js'

export const CLAUDE_PATH = process.env.CANVAS_CLAUDE_PATH ?? join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')

// GOAL §2: no built-in tools except Read in the chat lane; never Bash/Write/Edit/Web*.
const CHAT_DISALLOWED = ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'TodoWrite', 'KillShell', 'BashOutput']

function specKey(model: string, system: string) {
  return createHash('sha1').update(model + '\0' + system).digest('hex').slice(0, 12)
}

/** Pre-booted single-use processes for the surgical lane. */
class WarmPool {
  private idle: ClaudeProcess[] = []
  private target: ProcessSpec | null = null
  private targetKey = ''
  private filling = false
  constructor(private size: number) {}

  setTarget(spec: ProcessSpec) {
    const key = specKey(spec.model, spec.systemPrompt)
    if (key === this.targetKey) return
    this.targetKey = key
    this.target = spec
    // discard warm processes of the old spec
    const old = this.idle.splice(0)
    for (const p of old) p.kill().catch(() => {})
    void this.refill()
  }

  async refill() {
    if (this.filling || !this.target) return
    this.filling = true
    try {
      while (this.idle.length < this.size) {
        const p = new ClaudeProcess(this.target, CLAUDE_PATH)
        this.idle.push(p)
        // don't wait for init here; the taker waits
      }
    } finally {
      this.filling = false
    }
  }

  /** Returns a warm process if the spec matches, else a cold one. */
  take(spec: ProcessSpec): { proc: ClaudeProcess; warm: boolean } {
    const key = specKey(spec.model, spec.systemPrompt)
    if (key !== this.targetKey) {
      this.setTarget(spec)
      return { proc: new ClaudeProcess(spec, CLAUDE_PATH), warm: false }
    }
    // drop any dead ones
    this.idle = this.idle.filter((p) => !p.isEnded)
    const p = this.idle.shift()
    void this.refill()
    if (p) return { proc: p, warm: true }
    return { proc: new ClaudeProcess(spec, CLAUDE_PATH), warm: false }
  }

  async killAll() {
    const all = this.idle.splice(0)
    await Promise.all(all.map((p) => p.kill()))
  }

  get stats() { return { idle: this.idle.length, size: this.size, key: this.targetKey } }
}

export class ClaudeProvider implements Provider {
  id = 'claude'
  private pool: WarmPool
  private chats = new Map<string, ClaudeProcess>()
  private idleTimer: NodeJS.Timeout
  lastRateLimit: Extract<Frame, { type: 'rate_limit' }> | null = null

  constructor(poolSize = 2) {
    this.pool = new WarmPool(poolSize)
    // Kill chat processes idle for > 15 min; Phase 6 resumes them from session.json.
    this.idleTimer = setInterval(() => {
      const now = Date.now()
      for (const [k, p] of this.chats) {
        if (!p.busy && now - p.lastUsedAt > 15 * 60_000) {
          log.info(`[chat ${k}] idle, killing process ${p.id}`)
          this.chats.delete(k)
          p.kill().catch(() => {})
        }
      }
    }, 60_000)
    this.idleTimer.unref()
  }

  /** Pre-boot the surgical pool for a given system prompt/model. */
  warm(model: string, system: string) {
    this.pool.setTarget(this.surgicalSpec(model, system))
  }

  get poolStats() { return this.pool.stats }

  private surgicalSpec(model: string, system: string): ProcessSpec {
    return { model, systemPrompt: system, tools: [], persistSession: false, permissionMode: 'dontAsk' }
  }

  async listModels() {
    return [
      { id: 'sonnet', label: 'Sonnet (default for edits)' },
      { id: 'opus', label: 'Opus' },
      { id: 'fable', label: 'Fable' },
      { id: 'haiku', label: 'Haiku' },
    ]
  }

  cliVersionCheck(): { cli: string; expected: string; ok: boolean } {
    let cli = 'unknown'
    try { cli = execFileSync(CLAUDE_PATH, ['--version'], { encoding: 'utf8' }).trim().split(' ')[0] } catch {}
    let expected = 'unknown'
    try {
      const pkgDir = dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk')))
      const manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8'))
      expected = manifest.version
    } catch {}
    return { cli, expected, ok: cli === expected }
  }

  async probeAuth() {
    const t0 = Date.now()
    const p = new ClaudeProcess(this.surgicalSpec('haiku', 'Reply with exactly OK.'), CLAUDE_PATH)
    let apiKeySource = 'unknown'
    let ok = false
    let detail = ''
    try {
      for await (const f of p.send('Reply with exactly the word OK.')) {
        if (f.type === 'init') apiKeySource = f.apiKeySource
        if (f.type === 'rate_limit') this.lastRateLimit = f
        if (f.type === 'done') { ok = !f.isError; detail = f.text }
        if (f.type === 'error') detail = f.message
      }
    } finally {
      await p.kill()
    }
    const usingApiKey = apiKeySource !== 'none'
    return { ok, usingApiKey, detail: `apiKeySource=${apiKeySource}; ${detail.slice(0, 80)}; ${Date.now() - t0}ms` }
  }

  async *oneShot(req: OneShotRequest): AsyncIterable<Frame> {
    const spec = this.surgicalSpec(req.model, req.system)
    const { proc, warm } = this.pool.take(spec)
    const t0 = Date.now()
    log.info(`[oneshot] ${warm ? 'warm' : 'cold'} process ${proc.id}`)
    try {
      for await (const f of proc.send(req.prompt, req.signal)) {
        if (f.type === 'rate_limit') this.lastRateLimit = f
        yield f
        if (f.type === 'done') log.info(`[oneshot] ${proc.id} done in ${Date.now() - t0}ms`)
      }
    } finally {
      // single use — fresh context every time (GOAL §7)
      proc.kill().catch(() => {})
    }
  }

  private buildMcp(tools: CustomTool[]) {
    if (!tools.length) return undefined
    const defs = tools.map((t) =>
      tool(t.name, t.description, t.schema as any, async (args: any) => {
        const r = await t.handler(args)
        return { content: [{ type: 'text' as const, text: r.text }], isError: !r.ok }
      }),
    )
    return { canvas: createSdkMcpServer({ name: 'canvas', version: '1.0.0', tools: defs }) }
  }

  async *chat(req: ChatRequest): AsyncIterable<Frame> {
    const key = req.conversationKey
    let proc = this.chats.get(key)
    const wantKey = specKey(req.model, req.system) + '|' + req.cwd
    const haveKey = proc ? specKey(proc.spec.model, proc.spec.systemPrompt) + '|' + proc.spec.cwd : ''
    if (proc && (proc.isEnded || haveKey !== wantKey || proc.busy)) {
      if (proc.busy) throw new Error('A chat turn is already in flight for this document')
      this.chats.delete(key)
      await proc.kill()
      proc = undefined
    }
    if (!proc) {
      const spec: ProcessSpec = {
        model: req.model,
        systemPrompt: req.system,
        cwd: req.cwd,
        tools: ['Read'],
        allowedTools: ['Read', ...(req.tools.length ? ['mcp__canvas'] : [])],
        disallowedTools: CHAT_DISALLOWED,
        permissionMode: 'dontAsk',
        mcpServers: this.buildMcp(req.tools),
        resume: req.sessionId,
        persistSession: true,
      }
      proc = new ClaudeProcess(spec, CLAUDE_PATH)
      this.chats.set(key, proc)
      log.info(`[chat ${key}] new process ${proc.id}${req.sessionId ? ` resume=${req.sessionId}` : ''}`)
    }
    for await (const f of proc.send(req.prompt, req.signal)) {
      if (f.type === 'rate_limit') this.lastRateLimit = f
      yield f
    }
    if (proc.isEnded) this.chats.delete(key)
  }

  async endChat(key: string) {
    const p = this.chats.get(key)
    if (!p) return
    this.chats.delete(key)
    await p.kill()
  }

  get chatStats() {
    return [...this.chats.entries()].map(([k, p]) => ({ key: k, proc: p.id, busy: p.busy, sessionId: p.sessionId }))
  }

  async shutdown() {
    clearInterval(this.idleTimer)
    const chats = [...this.chats.values()]
    this.chats.clear()
    await Promise.all([this.pool.killAll(), ...chats.map((p) => p.kill())])
  }
}
