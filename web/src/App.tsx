import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import { api, clientId, type AppConfig, type DocMeta, type DocSummary, type FilesInfo, type Status } from './api'
import { ChatPane, type ChatMessage } from './ChatPane'
import { Editor as CoreEditor } from '@tiptap/react'
import { Editor, extensions } from './Editor'
import { FilesBar } from './FilesBar'
import { FirstRun } from './FirstRun'
import { InstructionsPicker } from './Instructions'
import { Sidebar } from './Sidebar'
import { capture } from './surgical/capture'
import { trackRange, untrackRange } from './surgical/plugin'
import { useChatEdits } from './chatEdits'

interface OpenDoc { meta: DocMeta; json: unknown | null; markdown: string; readOnly: boolean }

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<OpenDoc | null>(null)
  const [sidebar, setSidebar] = useState(true)
  const [showInstr, setShowInstr] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error' | ''>('')
  const [editor, setEditor] = useState<TiptapEditor | null>(null)
  const editorRef = useRef<TiptapEditor | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Last non-empty selection in the document; persists while the user types in the chat box.
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null)
  const [includeSel, setIncludeSel] = useState(false)
  const [actionEntries, setActionEntries] = useState<ChatMessage[]>([])
  const [, setFilesInfo] = useState<FilesInfo | null>(null)
  const [transcriptVersion, setTranscriptVersion] = useState(0)

  const slug = current?.meta.slug ?? null
  const pushAction = useCallback((e: { id: string; text: string; revertable: boolean; afterText?: string }) => setActionEntries((es) => [...es, { id: e.id, ts: new Date().toISOString(), role: 'action', text: e.text, action: { revertable: e.revertable, afterText: e.afterText } }]), [])
  const chatEdits = useChatEdits(editor, slug, pushAction)

  const refreshDocs = useCallback((q = query) => api.docs(q).then(setDocs).catch((e) => setError(e.message)), [query])

  useEffect(() => { api.config().then(setConfig).catch((e) => setError(e.message)) }, [])
  useEffect(() => {
    let alive = true
    const tick = () => api.status().then((s) => alive && setStatus(s)).catch(() => {})
    tick(); const t = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  useEffect(() => { if (config?.workspaceRoot) void refreshDocs() }, [config?.workspaceRoot, refreshDocs])
  useEffect(() => {
    const h = () => { if (config?.workspaceRoot) void refreshDocs() }
    window.addEventListener('focus', h)
    return () => window.removeEventListener('focus', h)
  }, [config?.workspaceRoot, refreshDocs])

  useEffect(() => {
    if (!config?.workspaceRoot || current) return
    const last = localStorage.getItem('canvas-last-doc')
    if (last) void openDoc(last)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.workspaceRoot])

  async function openDoc(s: string) {
    try {
      if (current) void api.close(current.meta.slug, clientId)
      const [d, o] = await Promise.all([api.doc(s), api.open(s, clientId)])
      setCurrent({ meta: d.meta, json: d.json, markdown: d.markdown, readOnly: o.readOnly })
      setActionEntries([])
      setSel(null)
      localStorage.setItem('canvas-last-doc', s)
      setSaveState('')
    } catch (e: any) { setError(e.message); localStorage.removeItem('canvas-last-doc') }
  }

  useEffect(() => {
    if (!slug) return
    const t = setInterval(() => api.open(slug, clientId).then((o) => setCurrent((c) => (c && c.meta.slug === slug && c.readOnly !== o.readOnly ? { ...c, readOnly: o.readOnly } : c))).catch(() => {}), 15000)
    const bye = () => api.close(slug, clientId)
    window.addEventListener('pagehide', bye)
    return () => { clearInterval(t); window.removeEventListener('pagehide', bye) }
  }, [slug])

  const onSave = useCallback((json: unknown, markdown: string, docSlug: string) => {
    if (!current || (current.meta.slug === docSlug && current.readOnly)) return
    setSaveState('saving')
    api.saveContent(docSlug, json, markdown, clientId)
      .then(() => { setSaveState('saved'); void refreshDocs() })
      .catch((e) => { setSaveState('error'); setError(e.message) })
  }, [current?.meta.slug, current?.readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  async function newDoc() {
    const title = prompt('Title for the new document:', 'Untitled')
    if (title === null) return
    const { meta } = await api.createDoc(title)
    await refreshDocs()
    await openDoc(meta.slug)
  }
  /** New document from a .docx: convert on the server, parse with the editor schema here, save, then open. */
  async function importWord(file: File) {
    try {
      const r = await api.importDocx(file)
      const tmp = new CoreEditor({ extensions, content: r.html })
      const json = tmp.getJSON(), markdown = tmp.getMarkdown()
      tmp.destroy()
      const { meta } = await api.createDoc(r.title)
      await api.saveContent(meta.slug, json, markdown, clientId)
      await api.addAction(meta.slug, `⬆ Imported from ${file.name}${r.warnings.length ? ` — ${r.warnings.join(' ')}` : ''}`)
      await refreshDocs()
      await openDoc(meta.slug)
      if (r.warnings.length) setError(`Imported "${file.name}" with notes: ${r.warnings.join(' ')}`)
    } catch (e: any) { setError(`Import failed: ${e.message}`) }
  }
  async function exportWord(json: unknown) {
    if (!current) return
    try {
      const blob = await api.exportDocx(current.meta.slug, json)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = (current.meta.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'document') + '.docx'
      document.body.appendChild(a); a.click(); a.remove()
      window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    } catch (e: any) { setError(`Word export failed: ${e.message}`) }
  }
  async function rename(s: string) {
    const d = docs.find((x) => x.slug === s)
    const title = prompt('New title:', d?.title ?? '')
    if (!title) return
    const { meta } = await api.patchMeta(s, { title })
    if (current?.meta.slug === s) setCurrent({ ...current, meta })
    await refreshDocs()
  }
  async function duplicate(s: string) { const { meta } = await api.duplicateDoc(s); await refreshDocs(); await openDoc(meta.slug) }
  async function remove(s: string) {
    if (!confirm('Move this document to the workspace trash?')) return
    await api.deleteDoc(s)
    if (current?.meta.slug === s) { setCurrent(null); localStorage.removeItem('canvas-last-doc') }
    await refreshDocs()
  }
  async function setInstructions(names: string[]) {
    if (!current) return
    setCurrent((c) => c && ({ ...c, meta: { ...c.meta, instructions: names } }))
    const { meta } = await api.patchMeta(current.meta.slug, { instructions: names })
    setCurrent((c) => c && ({ ...c, meta }))
    setTranscriptVersion((v) => v + 1) // backend appended a "new session" note
  }
  async function setModel(lane: 'chat' | 'surgical', model: string) {
    if (!current) return
    const { meta } = await api.patchMeta(current.meta.slug, { models: { ...current.meta.models, [lane]: model } })
    setCurrent({ ...current, meta })
  }

  // Keep the highlighted span visible while "Include Highlighted" is on (the browser drops the native selection on blur).
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || ed.isDestroyed) return
    ed.view.dispatch(untrackRange(ed.state, 'chat-highlight'))
    if (includeSel && sel) ed.view.dispatch(trackRange(ed.state, { id: 'chat-highlight', from: sel.from, to: sel.to, cls: 'ai-selected' }))
  }, [includeSel, sel, editor])
  useEffect(() => { setIncludeSel(false); setSel(null) }, [slug])

  const highlighted = () => {
    const ed = editorRef.current
    if (!ed || !sel || sel.from >= sel.to || sel.to > ed.state.doc.content.size) return null
    const cap = capture(ed, sel.from, sel.to)
    if (!cap) return null
    const $from = ed.state.doc.resolve(sel.from)
    return { text: cap.selection, label: cap.label, blockId: `b${Math.min($from.index(0), ed.state.doc.childCount - 1) + 1}` }
  }

  if (!config) return <div className="pad muted">{error ?? 'Connecting to backend…'}</div>
  if (!config.workspaceRoot) return <FirstRun config={config} onDone={(root) => setConfig({ ...config, workspaceRoot: root })} />

  const authBad = status?.auth && (status.auth.usingApiKey || !status.auth.ok)
  const models = ['sonnet', 'opus', 'fable', 'haiku']

  return (
    <div className="app">
      {authBad && <div className="banner banner-danger">⚠ {status!.auth!.usingApiKey ? 'Using API credits, not your subscription.' : 'Auth probe failed.'} {status!.auth!.detail}</div>}
      {status && !status.cli.ok && <div className="banner banner-warn">CLI version {status.cli.cli} does not match the SDK's expected {status.cli.expected}.</div>}
      {current?.readOnly && <div className="banner banner-warn">This document is open in another tab. This tab is read-only until the other one closes.</div>}
      {error && (
        <div className="banner banner-danger banner-closable">
          <span className="banner-text">{error}</span>
          <button className="icon banner-close" title="Dismiss" aria-label="Dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}
      <div className="shell">
        <Sidebar docs={docs} current={slug} collapsed={!sidebar} onToggle={() => setSidebar(!sidebar)}
          onSelect={openDoc} onNew={newDoc} onImport={importWord} onRename={rename} onDuplicate={duplicate} onDelete={remove}
          onSearch={(q) => { setQuery(q); void refreshDocs(q) }} onRefresh={() => refreshDocs()} />
        {current ? (
          <div className="workspace">
            <aside className="pane pane-chat">
              <header className="pane-header">
                <span>Chat</span>
                <button className="chip-btn" title="Attach instruction sets" onClick={() => setShowInstr(true)}>
                  📎 {current.meta.instructions.length ? current.meta.instructions.map((n) => <span key={n} className="chip">{n}</span>) : <span className="muted">no instructions</span>}
                </button>
                <select value={current.meta.models.chat} onChange={(e) => setModel('chat', e.target.value)} title="Chat model">
                  {models.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
                <span className="status-dot" title={status ? JSON.stringify(status.rateLimit) : ''}>
                  {status?.rateLimit ? `5h ${Math.round((status.rateLimit.fiveHour ?? 0) * 100)}% · 7d ${Math.round((status.rateLimit.sevenDay ?? 0) * 100)}%` : '…'}
                </span>
              </header>
              <ChatPane slug={current.meta.slug} model={current.meta.models.chat} reloadKey={transcriptVersion}
                getMarkdown={() => editorRef.current?.getMarkdown() ?? current.markdown}
                getBlocks={chatEdits.getBlocks} onDocEdit={chatEdits.apply}
                externalEntries={actionEntries} canRevert={chatEdits.canRevert}
                onRevert={(m) => chatEdits.revert(m.id)}
                hasSelection={!!sel} includeSelection={includeSel} onIncludeSelection={setIncludeSel} getHighlighted={highlighted}
                onNewTurn={chatEdits.clearChanged} onJump={(m) => chatEdits.jumpTo(m.id, (m as any).action?.afterText)} />
            </aside>
            <main className="pane pane-doc">
              <header className="pane-header">
                <input className="title-input" value={current.meta.title} onChange={(e) => setCurrent({ ...current, meta: { ...current.meta, title: e.target.value } })}
                  onBlur={(e) => api.patchMeta(current.meta.slug, { title: e.target.value }).then(({ meta }) => { setCurrent((c) => c && ({ ...c, meta })); void refreshDocs() })} />
                <span className={`save-state ${saveState}`}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed' : ''}</span>
              </header>
              <FilesBar slug={current.meta.slug} onChange={setFilesInfo} />
              <Editor slug={current.meta.slug} initialJson={current.json} initialMarkdown={current.markdown} readOnly={current.readOnly}
                onSave={onSave} onExportWord={exportWord} onReady={(ed) => { editorRef.current = ed; setEditor(ed); (window as any).__canvasEditor = ed }}
                onTransaction={(ed) => {
                  // Remember the last non-empty selection so it survives clicking into the chat box.
                  const { from, to, empty } = ed.state.selection
                  if (!empty) setSel((prev) => (prev && prev.from === from && prev.to === to ? prev : { from, to }))
                }} />
            </main>
          </div>
        ) : (
          <div className="empty-state">
            <h2>Pali</h2>
            <p className="muted">Pick a document from the library or create a new one.</p>
            <div className="row">
              <button className="primary" onClick={newDoc}>+ New document</button>
              <label className="button-like">⬆ Import Word document…
                <input type="file" accept=".docx" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importWord(f); e.target.value = '' }} />
              </label>
            </div>
          </div>
        )}
      </div>
      {showInstr && current && <InstructionsPicker attached={current.meta.instructions} onChange={setInstructions} onClose={() => setShowInstr(false)} />}
    </div>
  )
}
