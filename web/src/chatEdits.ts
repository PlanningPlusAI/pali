// Chat-driven edits (GOAL §7 / Phase 4): the frontend sends the document as top-level
// blocks with ids each turn, tracks each block's position through the plugin, and applies
// the backend's `doc_edit` frames as single transactions with snapshot + revert.
import { useCallback, useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import { Fragment, Node as PMNode } from '@tiptap/pm/model'
import { api } from './api'
import { getRange, surgicalKey, trackRange, untrackRange } from './surgical/plugin'

export interface Block { id: string; md: string }
export interface DocEdit {
  type: 'doc_edit'
  op: 'replace_block' | 'replace_range' | 'insert_after' | 'insert_at_end' | 'delete_range'
  fromId?: string
  toId?: string
  newIds?: string[]
  markdown?: string
  summary: string
}

interface Revert { appliedId: string; before: JSONContent[]; afterPlain: string; summary: string }

/** Map a plain-text snippet to a document position (used to jump to edits recorded in earlier sessions). */
function findSnippet(ed: Editor, snippet: string): { from: number; to: number } | null {
  const s = snippet.trim().slice(0, 120)
  if (!s) return null
  let hit: { from: number; to: number } | null = null
  ed.state.doc.descendants((node, pos) => {
    if (hit || !node.isTextblock) return
    const t = node.textContent
    const i = t.indexOf(s)
    if (i >= 0) hit = { from: pos + 1 + i, to: pos + 1 + i + s.length }
    else if (t && s.startsWith(t.slice(0, 40)) && t.length > 20) hit = { from: pos + 1, to: pos + 1 + t.length }
  })
  return hit
}

const T = (id: string) => `chat-${id}`

export function useChatEdits(editor: Editor | null, slug: string | null, onActionRecord?: (entry: { id: string; text: string; revertable: boolean; afterText?: string }) => void) {
  const edRef = useRef(editor); edRef.current = editor
  const slugRef = useRef(slug); slugRef.current = slug
  const reverts = useRef(new Map<string, Revert>())

  /** Remove every persistent 'changed since last message' highlight. */
  const clearChanged = useCallback(() => {
    const ed = edRef.current
    if (!ed || ed.isDestroyed) return
    const st = surgicalKey.getState(ed.state)
    if (st) for (const id of st.ranges.keys()) if (id.startsWith('changed-')) ed.view.dispatch(untrackRange(ed.state, id))
  }, [])
  useEffect(() => { reverts.current.clear(); clearChanged() }, [slug, clearChanged])

  /** Snapshot the document as blocks and (re)register a tracked range per block. */
  const getBlocks = useCallback((): Block[] => {
    const ed = edRef.current
    if (!ed) return []
    // Drop last turn's block ranges.
    const st = surgicalKey.getState(ed.state)
    if (st) for (const id of st.ranges.keys()) if (id.startsWith('chat-')) ed.view.dispatch(untrackRange(ed.state, id))
    const blocks: Block[] = []
    ed.state.doc.forEach((node, offset, index) => {
      const id = `b${index + 1}`
      const md = ed.markdown!.serialize({ type: 'doc', content: [node.toJSON()] }).trim()
      blocks.push({ id, md })
      ed.view.dispatch(trackRange(ed.state, { id: T(id), from: offset, to: offset + node.nodeSize, cls: 'chat-block' }))
    })
    return blocks
  }, [])

  const parseBlocks = (ed: Editor, md: string): PMNode[] => {
    const json: JSONContent = ed.markdown!.parse(md)
    const nodes = (json.content ?? []).map((b) => PMNode.fromJSON(ed.schema, b))
    return nodes.length ? nodes : [ed.schema.nodes.paragraph.create()]
  }

  const flash = (ed: Editor, from: number, to: number) => {
    const id = `flash-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    ed.view.dispatch(trackRange(ed.state, { id, from, to, cls: 'ai-fresh' }))
    window.setTimeout(() => { const e = edRef.current; if (e && !e.isDestroyed) e.view.dispatch(untrackRange(e.state, id)) }, 4000)
  }

  const apply = useCallback(async (e: DocEdit): Promise<boolean> => {
    const ed = edRef.current
    const docSlug = slugRef.current
    if (!ed || !docSlug) return false
    const rangeOf = (id: string) => { const r = getRange(ed.state, T(id)); if (!r) throw new Error(`block ${id} not found in editor`); return r }
    try {
      let from: number, to: number
      let nodes: PMNode[] = []
      switch (e.op) {
        case 'replace_block': { const r = rangeOf(e.fromId!); from = r.from; to = r.to; nodes = parseBlocks(ed, e.markdown!); break }
        case 'replace_range': { from = rangeOf(e.fromId!).from; to = rangeOf(e.toId!).to; nodes = parseBlocks(ed, e.markdown!); break }
        case 'insert_after': { from = to = rangeOf(e.fromId!).to; nodes = parseBlocks(ed, e.markdown!); break }
        case 'insert_at_end': { from = to = ed.state.doc.content.size; nodes = parseBlocks(ed, e.markdown!); break }
        case 'delete_range': { from = rangeOf(e.fromId!).from; to = rangeOf(e.toId!).to; nodes = []; break }
      }
      if (from > to) throw new Error('inverted range')
      const before: JSONContent[] = []
      ed.state.doc.slice(from, to).content.forEach((n) => before.push(n.toJSON()))
      void api.snapshot(docSlug, `chat-${e.op}`, ed.getJSON())
      const frag = Fragment.from(nodes)
      const tr = ed.state.tr.replaceWith(from, to, frag).setMeta('chatApply', true)
      ed.view.dispatch(tr)
      // Track the new blocks under their ids so later ops in the same turn can address them.
      let pos = from
      nodes.forEach((n, i) => {
        const id = e.newIds?.[i]
        if (id) ed.view.dispatch(trackRange(ed.state, { id: T(id), from: pos, to: pos + n.nodeSize, cls: 'chat-block' }))
        pos += n.nodeSize
      })
      const newTo = from + frag.size
      if (newTo > from) flash(ed, from, newTo)
      const appliedId = `chat-applied-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      ed.view.dispatch(trackRange(ed.state, { id: appliedId, from, to: newTo, cls: 'ai-applied' }))
      // Muted-yellow 'changed since your last message' highlight; cleared when the next message is sent.
      if (newTo > from) ed.view.dispatch(trackRange(ed.state, { id: `changed-${appliedId}`, from, to: newTo, cls: 'ai-changed' }))
      // Human label: what was removed/replaced (or added), by content rather than by id.
      const hint = (js: JSONContent[]) => {
        const first = js[0]
        const t = (first?.content ?? []).map((n: any) => n.text ?? '').join('').trim()
        const kind = first?.type === 'heading' ? 'section' : first?.type === 'bulletList' || first?.type === 'orderedList' ? 'list' : 'paragraph'
        return t ? `${kind} "${t.slice(0, 40)}${t.length > 40 ? '…' : ''}"` : kind
      }
      const verb = e.op === 'delete_range' ? 'removed' : e.op.startsWith('insert') ? 'added' : 'replaced'
      const count = e.op === 'delete_range' || e.op.startsWith('replace') ? before.length : nodes.length
      const text = `✎ ${verb} ${hint(e.op.startsWith('insert') ? nodes.map((n) => n.toJSON()) : before)}${count > 1 ? ` (+${count - 1} more block${count > 2 ? 's' : ''})` : ''}`
      const afterText = ed.state.doc.textBetween(from, newTo, '\n', ' ').slice(0, 200)
      const entry = await api.addAction(docSlug, text, { kind: 'chat', op: e.op, revertable: true, before, afterText })
      reverts.current.set(entry.id, { appliedId, before, afterPlain: ed.state.doc.textBetween(from, newTo, '\n', ' '), summary: e.summary })
      onActionRecord?.({ id: entry.id, text, revertable: true, afterText })
      return true
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      void api.addAction(docSlug, `✗ chat edit not applied (${e.op}): ${msg}`, { kind: 'chat-failed' })
      onActionRecord?.({ id: `local-fail-${Date.now()}`, text: `✗ chat edit not applied: ${msg}`, revertable: false })
      return false
    }
  }, [onActionRecord])

  const canRevert = useCallback((id: string) => reverts.current.has(id), [])

  const revert = useCallback((id: string): boolean => {
    const ed = edRef.current
    const info = reverts.current.get(id)
    if (!ed || !info) return false
    const r = getRange(ed.state, info.appliedId)
    if (!r) return false
    if (ed.state.doc.textBetween(r.from, r.to, '\n', ' ') !== info.afterPlain && !confirm('The changed text has been edited since. Revert anyway?')) return false
    const nodes = info.before.map((j) => PMNode.fromJSON(ed.schema, j))
    const frag = Fragment.from(nodes)
    ed.view.dispatch(ed.state.tr.replaceWith(r.from, r.to, frag).setMeta('chatRevert', true))
    ed.view.dispatch(untrackRange(ed.state, info.appliedId))
    ed.view.dispatch(untrackRange(ed.state, `changed-${info.appliedId}`))
    if (frag.size) flash(ed, r.from, r.from + frag.size)
    reverts.current.delete(id)
    if (slugRef.current) void api.addAction(slugRef.current, `↶ reverted: ${info.summary}`, { kind: 'revert' })
    onActionRecord?.({ id: `local-rv-${Date.now()}`, text: `↶ reverted: ${info.summary}`, revertable: false })
    return true
  }, [onActionRecord])

  /** Scroll the document to an edit: by tracked range if from this session, else by the recorded text snippet. */
  const jumpTo = useCallback((entryId: string, afterText?: string): boolean => {
    const ed = edRef.current
    if (!ed) return false
    const info = reverts.current.get(entryId)
    const tracked = info ? getRange(ed.state, info.appliedId) : undefined
    let r: { from: number; to: number } | undefined = tracked ? { from: tracked.from, to: tracked.to } : undefined
    if ((!r || r.from >= r.to) && afterText) r = findSnippet(ed, afterText) ?? undefined
    if (!r || r.from >= r.to) return false
    const to = Math.min(r.to, ed.state.doc.content.size)
    ed.chain().focus().setTextSelection({ from: r.from, to }).scrollIntoView().run()
    flash(ed, r.from, to)
    return true
  }, [])

  return { getBlocks, apply, revert, canRevert, clearChanged, jumpTo }
}
