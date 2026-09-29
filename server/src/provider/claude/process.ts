// One SDK-driven CLI process in streaming-input mode. Boots immediately on
// construction (the CLI starts before the first user message arrives), then
// accepts turns via send(). Used both by the surgical pool (one turn, then
// kill) and the chat lane (many turns).
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Frame } from '../types.js'
import { log } from '../../log.js'

export interface ProcessSpec {
  model: string
  systemPrompt: string
  cwd?: string
  /** built-in tools to allow; [] = none */
  tools: string[]
  /** Pre-approved tools for dontAsk mode (built-ins and mcp__<server> prefixes). */
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: Options['permissionMode']
  mcpServers?: Options['mcpServers']
  resume?: string
  persistSession: boolean
}

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiters: Array<(v: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false
  push(m: SDKUserMessage) {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: m, done: false })
    else this.items.push(m)
  }
  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as any, done: true })
        return new Promise((r) => this.waiters.push(r))
      },
    }
  }
}

class FrameSink {
  private items: Frame[] = []
  private waiters: Array<(v: IteratorResult<Frame>) => void> = []
  private done = false
  push(f: Frame) {
    if (this.done) return
    const w = this.waiters.shift()
    if (w) w({ value: f, done: false })
    else this.items.push(f)
    if (f.type === 'done' || f.type === 'error') this.finish()
  }
  finish() {
    this.done = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true })
  }
  iterable(): AsyncIterable<Frame> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (self.items.length) return Promise.resolve({ value: self.items.shift()!, done: false })
            if (self.done) return Promise.resolve({ value: undefined as any, done: true })
            return new Promise((r) => self.waiters.push(r))
          },
        }
      },
    }
  }
}

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  // GOAL §2: never let an API key leak into the child, or it silently bills credits.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  // Belt and braces: bare/simple mode disables OAuth.
  delete env.CLAUDE_CODE_SIMPLE
  return env
}

let seq = 0

export class ClaudeProcess {
  readonly id = `p${++seq}`
  readonly spec: ProcessSpec
  readonly bootedAt = Date.now()
  private q: Query
  private input = new MessageQueue()
  private sink: FrameSink | null = null
  private text = ''
  private ended = false
  private endedPromise: Promise<void>
  init: Extract<Frame, { type: 'init' }> | null = null
  private initWaiters: Array<() => void> = []
  sessionId: string | null = null
  lastUsedAt = Date.now()
  busy = false

  constructor(spec: ProcessSpec, claudePath: string) {
    this.spec = spec
    const opts: Options = {
      pathToClaudeCodeExecutable: claudePath,
      env: childEnv(),
      model: spec.model,
      systemPrompt: spec.systemPrompt,
      settingSources: [],
      tools: spec.tools,
      allowedTools: spec.allowedTools,
      disallowedTools: spec.disallowedTools,
      permissionMode: spec.permissionMode ?? 'dontAsk',
      mcpServers: spec.mcpServers,
      strictMcpConfig: true,
      persistSession: spec.persistSession,
      includePartialMessages: true,
      resume: spec.resume,
      cwd: spec.cwd,
      maxTurns: 40,
    }
    this.q = query({ prompt: this.input, options: opts })
    this.endedPromise = this.pump().catch((e) => {
      log.warn(`[${this.id}] pump error: ${e?.message ?? e}`)
      this.sink?.push({ type: 'error', message: String(e?.message ?? e) })
    }).finally(() => {
      this.ended = true
      this.sink?.push({ type: 'error', message: 'process ended' })
      for (const w of this.initWaiters.splice(0)) w()
    })
  }

  get isEnded() { return this.ended }

  private async pump() {
    for await (const m of this.q) this.handle(m)
  }

  private handle(m: SDKMessage) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.sessionId = m.session_id
          this.init = { type: 'init', sessionId: m.session_id, apiKeySource: String(m.apiKeySource), model: m.model, tools: m.tools }
          for (const w of this.initWaiters.splice(0)) w()
          this.sink?.push(this.init)
        }
        break
      case 'rate_limit_event': {
        const info: any = m.rate_limit_info
        const uw = info?.unifiedWindows ?? {}
        this.sink?.push({ type: 'rate_limit', fiveHour: uw.five_hour?.utilization, sevenDay: uw.seven_day?.utilization, status: info?.status, raw: info })
        break
      }
      case 'stream_event': {
        const ev: any = m.event
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          this.text += ev.delta.text
          this.sink?.push({ type: 'text', text: ev.delta.text })
        }
        break
      }
      case 'assistant': {
        const content: any[] = (m.message as any)?.content ?? []
        for (const c of content) {
          if (c.type === 'tool_use') this.sink?.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input })
        }
        break
      }
      case 'user': {
        // tool results come back as user messages
        const content: any = (m.message as any)?.content
        if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'tool_result') {
              const out = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('') : String(c.content ?? '')
              this.sink?.push({ type: 'tool_result', id: c.tool_use_id, name: '', output: out, ok: !c.is_error })
            }
          }
        }
        break
      }
      case 'result': {
        const r: any = m
        this.sink?.push({
          type: 'done',
          sessionId: r.session_id,
          text: this.text || (typeof r.result === 'string' ? r.result : ''),
          isError: !!r.is_error || r.subtype !== 'success',
          durationMs: r.duration_ms ?? 0,
          costUsd: r.total_cost_usd,
        })
        this.busy = false
        break
      }
      default:
        break
    }
  }

  /** Resolves once the CLI has emitted its init frame (or died). */
  waitInit(): Promise<void> {
    if (this.init || this.ended) return Promise.resolve()
    return new Promise((r) => this.initWaiters.push(r))
  }

  /** Send one user turn; the returned iterable ends at the 'done' (or 'error') frame. */
  send(prompt: string, signal?: AbortSignal): AsyncIterable<Frame> {
    if (this.busy) throw new Error('process busy')
    if (this.ended) throw new Error('process ended')
    this.busy = true
    this.lastUsedAt = Date.now()
    this.text = ''
    const sink = new FrameSink()
    this.sink = sink
    if (this.init) sink.push(this.init) // replay init for late subscribers
    this.input.push({ type: 'user', session_id: this.sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: prompt } })
    if (signal) {
      const onAbort = () => {
        this.q.interrupt().catch(() => {})
        sink.push({ type: 'error', message: 'aborted' })
        this.busy = false
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    return sink.iterable()
  }

  async kill(): Promise<void> {
    if (this.ended) return
    try { this.input.close() } catch {}
    try { this.q.close() } catch {}
    await Promise.race([this.endedPromise, new Promise((r) => setTimeout(r, 3000))])
  }
}
