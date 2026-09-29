// Phase 2 library + instruction acceptance checks against a running backend + workspace.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:5199'
const WS = process.env.CANVAS_WORKSPACE ?? (await fetch(BASE + '/api/config').then((r) => r.json())).workspaceRoot
const H = { 'content-type': 'application/json' }
const get = (p) => fetch(BASE + p).then((r) => r.json())
const send = (m, p, b) => fetch(BASE + p, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json())
async function chatTurn(slug, prompt) {
  const res = await fetch(`${BASE}/api/docs/${slug}/chat`, { method: 'POST', headers: H, body: JSON.stringify({ prompt }) })
  const txt = await res.text()
  const done = txt.split('\n\n').map((c) => /^event: done\ndata: (.*)$/s.exec(c)).find(Boolean)
  return done ? JSON.parse(done[1]).text : '(no done frame)'
}

// 1. Three documents, each with its own transcript
const slugs = []
for (const [t, secret] of [['Alpha doc', 'pineapple'], ['Beta doc', 'saxophone'], ['Gamma doc', 'lighthouse']]) {
  const { meta } = await send('POST', '/api/docs', { title: t })
  slugs.push(meta.slug)
  await send('PUT', `/api/docs/${meta.slug}/content`, { json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `This is ${t}.` }] }] }, markdown: `This is ${t}.` })
  const reply = await chatTurn(meta.slug, `My secret word for this document is "${secret}". Reply with exactly: noted ${secret}`)
  console.log(`[${meta.slug}] reply: ${JSON.stringify(reply.slice(0, 60))}`)
}
for (const s of slugs) {
  const entries = await get(`/api/docs/${s}/chat`)
  console.log(`[${s}] transcript: ${entries.length} entries; user msgs: ${entries.filter((e) => e.role === 'user').map((e) => e.text.match(/"(\w+)"/)?.[1]).join(',')}`)
}
// Cross-check: ask Beta what Alpha's secret was
const leak = await chatTurn(slugs[1], 'What secret words have I told you in this conversation? List them all, nothing else.')
console.log(`[isolation] ${slugs[1]} knows: ${JSON.stringify(leak.slice(0, 120))} — contains pineapple? ${/pineapple/i.test(leak)} lighthouse? ${/lighthouse/i.test(leak)}`)
const prompts = await get('/api/debug/prompts')
const betaPrompts = prompts.filter((p) => p.slug === slugs[1]).map((p) => p.system + p.prompt).join('\n')
console.log(`[isolation] logged prompts for ${slugs[1]} mention pineapple/lighthouse? ${/pineapple|lighthouse/i.test(betaPrompts)}`)

// 2. Hand-copied folder appears after rescan
cpSync(`${WS}/${slugs[0]}`, `${WS}/hand-copied-folder`, { recursive: true })
const meta = JSON.parse(readFileSync(`${WS}/hand-copied-folder/meta.json`, 'utf8')); meta.title = 'Hand copied'
writeFileSync(`${WS}/hand-copied-folder/meta.json`, JSON.stringify(meta, null, 2))
const list = await get('/api/docs')
console.log('[rescan] hand-copied-folder listed:', list.some((d) => d.slug === 'hand-copied-folder' && d.title === 'Hand copied'))

// 3. Rename keeps folder path
await send('PATCH', `/api/docs/${slugs[2]}/meta`, { title: 'Gamma renamed' })
console.log('[rename] folder still exists:', existsSync(`${WS}/${slugs[2]}`), '| title now:', (await get(`/api/docs/${slugs[2]}`)).meta.title)

// 4. Delete moves to .trash
await send('DELETE', `/api/docs/hand-copied-folder`)
console.log('[delete] gone from workspace:', !existsSync(`${WS}/hand-copied-folder`), '| in .trash:', readdirSync(`${WS}/.trash`).some((n) => n.startsWith('hand-copied-folder')))

// 5. Instruction sets: created via API → file; file dropped in → listed; attach two → meta.json
await send('PUT', '/api/instructions/british-no-oxford', { body: '# British English, no Oxford comma\n\nWrite in British English spelling (colour, organise). Never use the Oxford comma.' })
console.log('[instr] file created:', existsSync(`${WS}/instructions/british-no-oxford.md`))
writeFileSync(`${WS}/instructions/pirate-voice.md`, '# Pirate voice\n\nAlways write like a pirate. Say "arr" at least once.')
const instr = await get('/api/instructions')
console.log('[instr] picker lists:', instr.map((i) => `${i.name} (${i.title})`).join(' | '))
await send('PATCH', `/api/docs/${slugs[0]}/meta`, { instructions: ['british-no-oxford', 'pirate-voice'] })
console.log('[instr] meta.json instructions:', JSON.parse(readFileSync(`${WS}/${slugs[0]}/meta.json`, 'utf8')).instructions)
const chatAfter = await get(`/api/docs/${slugs[0]}/chat`)
console.log('[instr] system note appended:', chatAfter.at(-1)?.role === 'system', JSON.stringify(chatAfter.at(-1)?.text.slice(0, 80)))
const styled = await chatTurn(slugs[0], 'In one sentence, tell me what colour the sea is.')
console.log('[instr] styled reply:', JSON.stringify(styled.slice(0, 160)))
const lastPrompt = (await get('/api/debug/prompts')).filter((p) => p.slug === slugs[0]).at(-1)
console.log('[instr] system prompt contains standing block:', lastPrompt.system.includes('Standing instructions from the user'), '| order ok:', lastPrompt.system.indexOf('British') < lastPrompt.system.indexOf('Pirate'))
console.log('SLUGS', slugs.join(' '))
