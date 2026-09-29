import { useState } from 'react'
import { api, type AppConfig } from './api'

export function FirstRun({ config, onDone }: { config: AppConfig; onDone: (root: string) => void }) {
  const [root, setRoot] = useState(config.defaultRoot)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function submit(path: string) {
    setBusy(true); setErr(null)
    try { const r = await api.setConfig(path); onDone(r.workspaceRoot) }
    catch (e: any) { setErr(e.message) }
    finally { setBusy(false) }
  }
  return (
    <div className="firstrun">
      <div className="card">
        <h1>Choose a workspace folder</h1>
        <p>All documents, reference files and instruction sets live under one folder as plain files. You can move it later by editing the app config.</p>
        <label>Workspace folder
          <input value={root} onChange={(e) => setRoot(e.target.value)} spellCheck={false} />
        </label>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => submit(root)}>Use this folder</button>
          <button disabled={busy} onClick={() => setRoot(config.defaultRoot)}>Reset to default</button>
        </div>
        {config.oneDriveRoot && (
          <details>
            <summary>Use a OneDrive folder instead (not recommended)</summary>
            <p className="muted">Autosave writes every second or so while you type. Inside a synced folder that means upload churn and occasional conflict copies. If you accept that:</p>
            <button disabled={busy} onClick={() => submit(config.oneDriveRoot!)}>Use {config.oneDriveRoot}</button>
          </details>
        )}
        {err && <div className="error">{err}</div>}
      </div>
    </div>
  )
}
