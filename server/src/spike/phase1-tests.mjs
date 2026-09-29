// Phase 1 acceptance checks against a running backend. Usage: node phase1-tests.mjs <timing|roundtrip|chat|nowrite|disconnect|shutdown>
const BASE = 'http://127.0.0.1:5199'
async function sse(path, body, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: opts.signal })
  const reader = res.body.getReader(); const dec = new TextDecoder()
  let buf = '', frames = [], ttft = -1
  while (true) {
    const { value, done } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      const m = /^event: (\w+)\ndata: (.*)$/s.exec(chunk); if (!m) continue
      const f = JSON.parse(m[2]); frames.push(f)
      if (f.type === 'text' && ttft < 0) ttft = Date.now() - t0
      if (opts.onFrame) opts.onFrame(f)
    }
  }
  const done = frames.find((f) => f.type === 'done')
  return { frames, ttft, wall: Date.now() - t0, text: done?.text ?? '', done }
}
const count = async () => (await fetch(BASE + '/api/status')).json()
const test = process.argv[2]

if (test === 'timing') {
  for (let i = 0; i < 3; i++) { const r = await sse('/api/oneshot', { prompt: 'Reply with exactly the word OK.' }); console.log(`warm #${i+1}: TTFT ${r.ttft}ms wall ${r.wall}ms text=${JSON.stringify(r.text)}`) }
  for (let i = 0; i < 2; i++) { const r = await sse('/api/oneshot', { prompt: 'Reply with exactly the word OK.', system: 'You are a terse assistant. Plain text only. (cold variant ' + i + ')' }); console.log(`cold #${i+1}: TTFT ${r.ttft}ms wall ${r.wall}ms text=${JSON.stringify(r.text)}`) }
}
if (test === 'roundtrip') {
  const payload = 'Path: C:\\Windows\\System32\\drivers\\etc\\hosts and D:\\12_Programing\\x\nRegex: \\d+\\s*\\w+ and a lone backslash \\ here\nLine "one" with \'quotes\'\nLine two & ampersand %PATH% %USERPROFILE%\n`backticks` and $dollar ${braces}\nnon-ASCII: café — naïve 日本語 🚀'
  const r = await sse('/api/oneshot', { prompt: 'Echo the following text back EXACTLY, byte for byte, with no commentary and no code fences:\n\n' + payload, system: 'You echo text exactly. Output only the text, nothing else.' })
  const got = r.text.replace(/\r\n/g, '\n').trim(); const want = payload.trim()
  console.log('roundtrip identical:', got === want); if (got !== want) { console.log('WANT:', JSON.stringify(want)); console.log('GOT: ', JSON.stringify(got)) }
}
if (test === 'chat') {
  const r = await sse('/api/chat', { prompt: 'Count from 1 to 15 in words, one per line.', conversationKey: 'test' }, { onFrame: (f) => { if (f.type === 'text') process.stdout.write(f.text) } })
  console.log(`\n-- chat TTFT ${r.ttft}ms wall ${r.wall}ms frames=${r.frames.length}`)
  const r2 = await sse('/api/chat', { prompt: 'What was the last number you said? Answer with just the word.', conversationKey: 'test' })
  console.log(`turn 2 (memory check): ${JSON.stringify(r2.text)} TTFT ${r2.ttft}ms wall ${r2.wall}ms`)
}
if (test === 'nowrite') {
  const r = await sse('/api/chat', { prompt: 'Create a file named hello.txt in your current working directory containing "hi". Use any tool you have. Then tell me exactly which tools you have available and whether the file was created.', conversationKey: 'nowrite' })
  console.log('tool calls:', r.frames.filter((f) => f.type === 'tool_call').map((f) => f.name + ' ' + JSON.stringify(f.input).slice(0, 100)))
  console.log('init tools:', JSON.stringify(r.frames.find((f) => f.type === 'init')?.tools))
  console.log('reply:', r.text.slice(0, 600))
}
if (test === 'disconnect') {
  const ac = new AbortController()
  await sse('/api/chat', { prompt: 'Write a 2000-word essay about rivers.', conversationKey: 'disc' }, { signal: ac.signal, onFrame: (f) => { if (f.type === 'text') ac.abort() } }).catch((e) => console.log('client aborted:', e.name))
  await new Promise((r) => setTimeout(r, 3000))
  console.log('chats after abort:', JSON.stringify((await count()).chats))
}
if (test === 'shutdown') {
  console.log('status before:', JSON.stringify(await count()))
  await fetch(BASE + '/api/shutdown', { method: 'POST' }).catch(() => {})
}
