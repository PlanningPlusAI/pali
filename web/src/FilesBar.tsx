import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type FilesInfo } from './api'

interface Props {
  slug: string
  onChange?: (info: FilesInfo) => void
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Reference-file chips with toggles + drop/upload (GOAL §8). */
export function FilesBar({ slug, onChange }: Props) {
  const [info, setInfo] = useState<FilesInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(() => api.files(slug).then((i) => { setInfo(i); onChange?.(i) }).catch((e) => setErr(e.message)), [slug, onChange])
  useEffect(() => { setInfo(null); setErr(null); void reload() }, [reload])

  async function upload(files: File[]) {
    if (!files.length) return
    setBusy(`Adding ${files.map((f) => f.name).join(', ')}…`)
    setErr(null)
    try {
      const r = await api.uploadFiles(slug, files)
      const bad = r.files.filter((f) => f.status === 'error')
      if (bad.length) setErr(bad.map((f) => `${f.name}: ${f.warning}`).join(' · '))
      await reload()
    } catch (e: any) { setErr(e.message) }
    finally { setBusy(null) }
  }

  // Expose a drop handler for the whole document pane.
  useEffect(() => {
    const pane = document.querySelector('.pane-doc') as HTMLElement | null
    if (!pane) return
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); pane.classList.add('drop-target') } }
    const leave = () => pane.classList.remove('drop-target')
    const drop = (e: DragEvent) => {
      pane.classList.remove('drop-target')
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      void upload([...e.dataTransfer.files])
    }
    pane.addEventListener('dragover', over); pane.addEventListener('dragleave', leave); pane.addEventListener('drop', drop)
    return () => { pane.removeEventListener('dragover', over); pane.removeEventListener('dragleave', leave); pane.removeEventListener('drop', drop) }
  }, [slug]) // eslint-disable-line react-hooks/exhaustive-deps

  const files = info?.files ?? []
  return (
    <div className="files-bar">
      <span className="muted small-label">Reference files</span>
      {files.map((f) => (
        <span key={f.name} className={`file-chip ${f.enabled ? 'on' : 'off'} ${f.status}`} title={`${f.type} · ${kb(f.size)} · ${f.chars.toLocaleString()} chars${f.pages ? ` · ${f.pages} pages` : ''}${f.warning ? `\n⚠ ${f.warning}` : ''}${info?.summarized.includes(f.name) ? '\nLarge: sent as outline + path' : info?.inlined.includes(f.name) ? '\nSmall: full text inlined' : ''}`}>
          <input type="checkbox" checked={!!f.enabled} disabled={f.status === 'error'} onChange={(e) => {
            const on = e.target.checked
            setInfo((i) => i && ({ ...i, files: i.files.map((x) => (x.name === f.name ? { ...x, enabled: on } : x)) })) // optimistic
            api.toggleFile(slug, f.name, on).then(reload)
          }} />
          <span className="file-name">{f.name}</span>
          {f.status === 'warning' && <span className="warn" title={f.warning}>⚠</span>}
          {f.status === 'error' && <span className="warn" title={f.warning}>✗</span>}
          {info?.summarized.includes(f.name) && <span className="muted">outline</span>}
          <button className="icon small" title="Remove file" onClick={() => { if (confirm(`Remove ${f.name} from this document?`)) api.deleteFile(slug, f.name).then(reload) }}>✕</button>
        </span>
      ))}
      <button className="quiet" onClick={() => inputRef.current?.click()} disabled={!!busy}>+ Add files</button>
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = '' }} />
      {busy && <span className="muted">{busy}</span>}
      {info?.degraded && <span className="warn-text">⚠ Files exceed the inline budget; outlines are sent instead of full text.</span>}
      {files.some((f) => f.status === 'warning') && <span className="warn-text">{files.filter((f) => f.status === 'warning').map((f) => `${f.name}: ${f.warning}`).join(' · ')}</span>}
      {err && <span className="warn-text">{err} <button className="icon small" title="Dismiss" aria-label="Dismiss" onClick={() => setErr(null)}>✕</button></span>}
    </div>
  )
}
