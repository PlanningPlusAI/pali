import { useEffect, useRef, useState } from 'react'
import { api, streamSse, type ChatEntry, type Frame } from './api'

export interface ChatMessage extends ChatEntry {
  streaming?: boolean
  meta?: string
}

interface Props {
  slug: string
  model: string
  /** Current document markdown, re-sent with every turn (GOAL §7 freshness). */
  getMarkdown: () => string
  /** Current document as id'd blocks (Phase 4 tools). */
  getBlocks?: () => { id: string; md: string }[]
  /** Apply a backend doc_edit frame to the editor. */
  onDocEdit?: (e: any) => Promise<boolean> | boolean
  /** Extra entries pushed from outside (e.g. surgical action records). */
  externalEntries?: ChatMessage[]
  canRevert?: (id: string) => boolean
  onRevert?: (entry: ChatMessage) => void
  /** Return true to handle the message locally (e.g. "now do the same to the next paragraph"). */
  onIntercept?: (text: string) => boolean
  /** Bump to reload the transcript from disk (e.g. after the backend appended a system note). */
  reloadKey?: number
  /** "Include Highlighted": append the document selection to the message. */
  hasSelection?: boolean
  includeSelection?: boolean
  onIncludeSelection?: (v: boolean) => void
  getHighlighted?: () => { text: string; label: string; blockId: string } | null
  /** Called when a new message is sent (clears 'changed since last message' highlights). */
  onNewTurn?: () => void
  /** Click on an edit record → scroll the document there. Return false if it could not be located. */
  onJump?: (entry: ChatMessage) => boolean
}

let nextId = 1

export function ChatPane({ slug, model, getMarkdown, getBlocks, onDocEdit, externalEntries, canRevert, onRevert, onIntercept, reloadKey, hasSelection, includeSelection, onIncludeSelection, getHighlighted, onNewTurn, onJump }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }) }, [messages])

  // Per-document transcript (GOAL §6): switching documents switches the whole conversation.
  useEffect(() => {
    abortRef.current?.abort()
    setMessages([])
    let alive = true
    api.chat(slug).then((es) => alive && setMessages(es)).catch(() => {})
    return () => { alive = false }
  }, [slug, reloadKey])

  useEffect(() => {
    if (externalEntries?.length) setMessages((ms) => [...ms, ...externalEntries.filter((e) => !ms.some((m) => m.id === e.id))])
  }, [externalEntries])

  const patch = (id: string, fn: (m: ChatMessage) => ChatMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)))

  async function send() {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    if (onIntercept?.(prompt)) {
      setMessages((ms) => [...ms, { id: `local-${nextId++}`, ts: new Date().toISOString(), role: 'user', text: prompt }])
      return
    }
    setBusy(true)
    onNewTurn?.()
    const userId = `local-${nextId++}`
    const asstId = `local-${nextId++}`
    const now = new Date().toISOString()
    const highlighted = includeSelection ? getHighlighted?.() ?? null : null
    const shown = highlighted ? `${prompt}\n\n▸ highlighted (${highlighted.label}): “${highlighted.text.length > 160 ? highlighted.text.slice(0, 160) + '…' : highlighted.text}”` : prompt
    setMessages((ms) => [...ms, { id: userId, ts: now, role: 'user', text: shown }, { id: asstId, ts: now, role: 'assistant', text: '', streaming: true }])
    const ac = new AbortController()
    abortRef.current = ac
    const t0 = performance.now()
    let ttft = -1
    try {
      await streamSse(`/api/docs/${slug}/chat`, { prompt, model, markdown: getMarkdown(), blocks: getBlocks?.(), highlighted }, (f: Frame) => {
        if ((f as any).type === 'doc_edit') {
          void onDocEdit?.(f)
        } else if (f.type === 'text') {
          if (ttft < 0) ttft = performance.now() - t0
          patch(asstId, (m) => ({ ...m, text: m.text + f.text }))
        } else if (f.type === 'tool_call') {
          // Document tools produce their own ✎ records when applied; only surface other tools (e.g. Read).
          if (!f.name.startsWith('mcp__canvas__')) setMessages((ms) => [...ms, { id: `local-${nextId++}`, ts: new Date().toISOString(), role: 'action', text: `⚙ ${f.name === 'Read' ? 'read ' + String((f.input as any)?.file_path ?? '').split(/[\/]/).pop() : f.name}` }])
        } else if (f.type === 'done') {
          patch(asstId, (m) => ({ ...m, streaming: false, meta: `${Math.round(ttft)}ms to first token · ${Math.round(performance.now() - t0)}ms total` }))
          if (f.isError) patch(asstId, (m) => ({ ...m, text: m.text || 'The model returned an error.', meta: 'error' }))
        } else if (f.type === 'error') {
          patch(asstId, (m) => ({ ...m, streaming: false, text: m.text || f.message, meta: 'error' }))
        }
      }, ac.signal)
    } catch (e: any) {
      if (e?.name !== 'AbortError') patch(asstId, (m) => ({ ...m, streaming: false, text: m.text || String(e?.message ?? e), meta: 'error' }))
      else patch(asstId, (m) => ({ ...m, streaming: false, meta: 'stopped' }))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  async function clear() {
    if (!confirm('Clear this document\'s chat transcript and start a new session?')) return
    await api.clearChat(slug)
    setMessages([])
  }

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <div className="chat-empty">Ask about the document, or tell me what to change.</div>}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role} ${m.meta === 'error' ? 'msg-error' : ''} ${m.role === 'action' && (m as any).action?.afterText !== undefined ? 'jumpable' : ''}`}
            title={m.role === 'action' && (m as any).action?.afterText !== undefined ? 'Click to show this change in the document' : undefined}
            onClick={(ev) => { if (m.role === 'action' && (m as any).action?.afterText !== undefined && !(ev.target as HTMLElement).closest('button')) { if (!onJump?.(m)) setMessages((ms) => ms.map((x) => (x.id === m.id ? { ...x, meta: 'not found in the current text' } : x))) } }}>
            <div className="msg-text">{m.text}{m.streaming && <span className="caret">▍</span>}</div>
            {m.role === 'action' && (m as any).action?.revertable && onRevert && canRevert?.(m.id) && <button className="link" onClick={() => onRevert(m)}>revert</button>}
            {m.meta && m.meta !== 'error' && <div className="msg-meta">{m.meta}</div>}
          </div>
        ))}
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() } }}
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          rows={3}
        />
        <div className="chat-actions">
          <label className={`include-sel ${hasSelection ? '' : 'muted'}`} title={hasSelection ? 'Append the text highlighted in the document to this message' : 'Highlight some text in the document first'}>
            <input type="checkbox" checked={!!includeSelection} onChange={(e) => onIncludeSelection?.(e.target.checked)} /> Include Highlighted
          </label>
          <span style={{ flex: 1 }} />
          <button type="button" className="quiet" onClick={clear} title="Clear transcript and start a new session">Clear</button>
          {busy ? <button type="button" onClick={() => abortRef.current?.abort()}>Stop</button> : <button type="submit" className="primary" disabled={!input.trim()}>Send</button>}
        </div>
      </form>
    </div>
  )
}
