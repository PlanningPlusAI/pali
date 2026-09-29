// Starts backend (tsx) and frontend (vite) together; Ctrl+C stops both.
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(name, cwd, args) {
  const p = spawn(npmCmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  p.on('exit', (code) => { console.log(`[${name}] exited ${code}`); shutdown() })
  return p
}

const procs = [run('server', join(root, 'server'), ['run', 'dev']), run('web', join(root, 'web'), ['run', 'dev'])]

let down = false
function shutdown() {
  if (down) return
  down = true
  for (const p of procs) { try { p.kill() } catch {} }
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
