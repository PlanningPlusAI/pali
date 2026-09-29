// App config lives outside the workspace: %APPDATA%\Pali\config.json (migrated from the old Canvas folder)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppConfig {
  workspaceRoot: string | null
}

const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
const dir = join(appData, 'Pali')
const file = join(dir, 'config.json')
// One-time migration from the app's previous name.
try {
  const old = join(appData, 'Canvas', 'config.json')
  if (!existsSync(file) && existsSync(old)) { mkdirSync(dir, { recursive: true }); writeFileSync(file, readFileSync(old)) }
} catch {}

export const DEFAULT_WORKSPACE = 'D:\\Pali-Workspace'
// Offered only as an explicit opt-in (GOAL §6: OneDrive churn).
export const ONEDRIVE_DOCUMENTS = process.env.OneDrive ? join(process.env.OneDrive, 'Documents', 'Pali-Workspace') : null

export function loadConfig(): AppConfig {
  try {
    if (existsSync(file)) return { workspaceRoot: null, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {}
  return { workspaceRoot: null }
}

export function saveConfig(c: AppConfig) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(c, null, 2))
}
