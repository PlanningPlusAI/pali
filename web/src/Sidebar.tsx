import { useEffect, useRef, useState } from 'react'
import { api, type DocSummary } from './api'

interface Props {
  docs: DocSummary[]
  current: string | null
  collapsed: boolean
  onToggle: () => void
  onSelect: (slug: string) => void
  onNew: () => void
  onImport: (file: File) => void
  onRename: (slug: string) => void
  onDuplicate: (slug: string) => void
  onDelete: (slug: string) => void
  onSearch: (q: string) => void
  onRefresh: () => void
}

function rel(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function Sidebar(p: Props) {
  const [q, setQ] = useState('')
  const [menu, setMenu] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  useEffect(() => { const t = setTimeout(() => p.onSearch(q), 200); return () => clearTimeout(t) }, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const h = () => setMenu(null); window.addEventListener('click', h); return () => window.removeEventListener('click', h) }, [])

  if (p.collapsed) return <div className="sidebar collapsed"><button className="icon" title="Show library" onClick={p.onToggle}>☰</button></div>
  return (
    <div className="sidebar">
      <div className="sidebar-head">
        <button className="icon" title="Hide library" onClick={p.onToggle}>☰</button>
        <span className="sidebar-title">Documents</span>
        <button className="icon" title="Rescan folder" onClick={p.onRefresh}>⟳</button>
        <button className="primary" onClick={p.onNew}>+ New</button>
      </div>
      <button className="quiet import-btn" title="Create a new document from a Word file" onClick={() => fileRef.current?.click()}>⬆ Import Word document…</button>
      <input ref={fileRef} type="file" accept=".docx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) p.onImport(f); e.target.value = '' }} />
      <input className="search" placeholder="Search titles and text…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="doc-list">
        {p.docs.length === 0 && <div className="muted pad">No documents{q ? ' match' : ' yet'}.</div>}
        {p.docs.map((d) => (
          <div key={d.slug} className={`doc-item ${d.slug === p.current ? 'active' : ''}`} onClick={() => p.onSelect(d.slug)}>
            <div className="doc-item-row">
              <div className="doc-title">{d.title}</div>
              <button className="icon small" onClick={(e) => { e.stopPropagation(); setMenu(menu === d.slug ? null : d.slug) }}>⋯</button>
            </div>
            <div className="doc-excerpt">{d.excerpt || <span className="muted">Empty</span>}</div>
            <div className="doc-time">{rel(d.updated)}</div>
            {menu === d.slug && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => { setMenu(null); p.onRename(d.slug) }}>Rename</button>
                <button onClick={() => { setMenu(null); p.onDuplicate(d.slug) }}>Duplicate</button>
                <button onClick={() => { setMenu(null); void api.reveal(d.slug) }}>Reveal in Explorer</button>
                <button className="danger" onClick={() => { setMenu(null); p.onDelete(d.slug) }}>Delete (to trash)</button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
