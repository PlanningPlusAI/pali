// Phase 6 "do this first": does a chat session created with the reduced options resume cleanly
// with identical options — and what happens with different options? Run: npx tsx src/spike/resume-test.ts
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_PATH } from '../provider/claude/adapter.js'
import { ClaudeProcess, type ProcessSpec } from '../provider/claude/process.js'

const cwd = join(tmpdir(), 'canvas-resume-test'); mkdirSync(cwd, { recursive: true })
const base: ProcessSpec = { model: 'sonnet', systemPrompt: 'You are a terse assistant inside a test. Reply briefly.', cwd, tools: ['Read'], allowedTools: ['Read'], disallowedTools: ['Bash', 'Write', 'Edit'], permissionMode: 'dontAsk', persistSession: true }

async function turn(p: ClaudeProcess, prompt: string) {
  let text = '', init: any = null, err = ''
  for await (const f of p.send(prompt)) { if (f.type === 'text') text += f.text; if (f.type === 'init') init = f; if (f.type === 'error') err = f.message; if (f.type === 'done' && f.isError) err = err || f.text }
  return { text: text.trim(), init, err }
}

console.log('1. fresh session, tell it a secret')
const p1 = new ClaudeProcess(base, CLAUDE_PATH)
const r1 = await turn(p1, 'The secret word is MARMALADE-19. Reply with exactly: stored')
console.log('   reply:', JSON.stringify(r1.text), '| session:', p1.sessionId, '| apiKeySource:', r1.init?.apiKeySource)
await p1.kill()

console.log('2. resume with IDENTICAL options')
const p2 = new ClaudeProcess({ ...base, resume: p1.sessionId! }, CLAUDE_PATH)
const r2 = await turn(p2, 'What is the secret word? Reply with just the word.')
console.log('   reply:', JSON.stringify(r2.text), '| remembered:', /MARMALADE-19/.test(r2.text), '| session id same:', p2.sessionId === p1.sessionId, '| err:', r2.err || 'none')
await p2.kill()

console.log('3. resume with a DIFFERENT system prompt (instruction set changed)')
const p3 = new ClaudeProcess({ ...base, resume: p1.sessionId!, systemPrompt: base.systemPrompt + '\n\nStanding instruction: always end your reply with the word PINEAPPLE.' }, CLAUDE_PATH)
const r3 = await turn(p3, 'What is the secret word? Reply with just the word.')
console.log('   reply:', JSON.stringify(r3.text), '| remembered:', /MARMALADE-19/.test(r3.text), '| new system prompt applied (ends with PINEAPPLE):', /PINEAPPLE\W*$/i.test(r3.text), '| err:', r3.err || 'none')
await p3.kill()

console.log('4. resume with a DIFFERENT model (haiku)')
const p4 = new ClaudeProcess({ ...base, resume: p1.sessionId!, model: 'haiku' }, CLAUDE_PATH)
const r4 = await turn(p4, 'What is the secret word? Reply with just the word.')
console.log('   reply:', JSON.stringify(r4.text), '| remembered:', /MARMALADE-19/.test(r4.text), '| model:', r4.init?.model, '| err:', r4.err || 'none')
await p4.kill()

console.log('5. resume with an MCP server + allowedTools added (tools changed)')
const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
const { z } = await import('zod')
const mcp = createSdkMcpServer({ name: 'canvas', version: '1.0.0', tools: [tool('ping', 'Replies pong', { x: z.string() }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))] })
const p5 = new ClaudeProcess({ ...base, resume: p1.sessionId!, allowedTools: ['Read', 'mcp__canvas'], mcpServers: { canvas: mcp } }, CLAUDE_PATH)
const r5 = await turn(p5, 'Call the ping tool with x="a", then tell me the secret word. Reply with: <tool result> <secret>')
console.log('   reply:', JSON.stringify(r5.text), '| remembered:', /MARMALADE-19/.test(r5.text), '| tools in init:', JSON.stringify(r5.init?.tools), '| err:', r5.err || 'none')
await p5.kill()
process.exit(0)
