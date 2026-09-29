// Phase 0 — auth spike. Proves subscription auth holds through the SDK,
// and that --bare breaks it.
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE = process.env.CANVAS_CLAUDE_PATH ?? join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  return env
}

async function positive() {
  console.log('=== POSITIVE: SDK one-shot, reduced options, API-key vars stripped ===')
  const t0 = Date.now()
  let firstToken = -1
  const q = query({
    prompt: 'Reply with exactly the word OK and nothing else.',
    options: {
      pathToClaudeCodeExecutable: CLAUDE,
      env: childEnv(),
      model: 'sonnet',
      settingSources: [],
      tools: [],
      persistSession: false,
      includePartialMessages: true,
      systemPrompt: 'You are a terse assistant.',
    },
  })
  for await (const msg of q) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      console.log('init: apiKeySource =', msg.apiKeySource, '| model =', msg.model, '| session =', msg.session_id, '| tools =', JSON.stringify(msg.tools))
    } else if (msg.type === 'rate_limit_event') {
      console.log('rate_limit_event:', JSON.stringify(msg.rate_limit_info))
    } else if (msg.type === 'stream_event') {
      const ev: any = msg.event
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (firstToken < 0) firstToken = Date.now() - t0
        process.stdout.write(`[delta "${ev.delta.text}"]`)
      }
    } else if (msg.type === 'result') {
      console.log('\nresult:', msg.subtype, '| wall', Date.now() - t0, 'ms | TTFT', firstToken, 'ms | total_cost_usd (list-price accounting, not a charge):', (msg as any).total_cost_usd)
      if ('result' in msg) console.log('text:', JSON.stringify((msg as any).result))
    }
  }
}

function negative(): Promise<void> {
  console.log('\n=== NEGATIVE: raw CLI with --bare (must FAIL auth) ===')
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE,
      ['-p', '--bare', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'],
      { shell: false, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.stdin.end('Reply with exactly the word OK.\n')
    child.on('close', (code) => {
      console.log('exit code:', code)
      console.log('stdout:', out.trim().slice(0, 600))
      console.log('stderr:', err.trim().slice(0, 600))
      resolve()
    })
  })
}

await positive()
await negative()
