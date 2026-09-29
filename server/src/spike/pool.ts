// Does streaming-input mode boot the process before the first user message?
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'
const CLAUDE = process.env.CANVAS_CLAUDE_PATH ?? join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
const env: Record<string,string> = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN

let release!: () => void
const gate = new Promise<void>((r) => (release = r))
async function* input(): AsyncIterable<SDKUserMessage> {
  await gate
  console.log('[t+%d] sending user message', Date.now() - t0)
  yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Reply with exactly the word OK.' } }
}
const t0 = Date.now()
const q = query({ prompt: input(), options: {
  pathToClaudeCodeExecutable: CLAUDE, env, model: 'sonnet', settingSources: [], tools: [],
  persistSession: false, includePartialMessages: true, systemPrompt: 'Terse.',
}})
// Release the message 3s after spawn so we can see whether init arrives before it.
setTimeout(() => release(), 3000)
let sent = -1
for await (const m of q) {
  const t = Date.now() - t0
  if (m.type === 'system' && m.subtype === 'init') console.log(`[t+${t}] INIT apiKeySource=${m.apiKeySource}`)
  else if (m.type === 'stream_event' && (m.event as any).type === 'content_block_delta') { console.log(`[t+${t}] first delta`); }
  else if (m.type === 'result') { console.log(`[t+${t}] result`, m.subtype); break }
  else console.log(`[t+${t}] ${m.type}`)
}
// second turn on the same process? -> would need a new generator; skip for now.
