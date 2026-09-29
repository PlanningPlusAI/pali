// Per-document surgical edit queue: one in flight, the rest pending; positions are
// tracked through the plugin so typing elsewhere never corrupts the splice (GOAL §5, §7).
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/core'
import { api, streamSse } from '../api'
import { capture as captureSel, type Capture } from './capture'
import { getRange, trackRange, untrackRange } from './plugin'
import { applySplice, parseReplacement, revertSplice } from './splice'

export interface EditJob {
  id: string
  instruction: string
  maxRatio?: number
  useInstructions: boolean
  useFiles: boolean
  status: 'pending' | 'working' | 'done' | 'failed'
  preview: string
  error?: string
  label: string
}

export interface RevertInfo {
  id: string
  kind: 'inline' | 'block'
  before: JSONContent[]
  label: string
  afterPlain: string
}

export interface Toast { id: string; text: string; revertId?: string }

let seq = 1

export function useSurgical(editor: Editor | null, slug: string | null, onActionRecord?: (entry: { id: string; text: string; revertable: boolean }) => void) {
  const [jobs, setJobs] = useState<EditJob[]>([])
  const [toast, setToast] = useState<Toast | null>(null)
  const [lastEdit, setLastEdit] = useState<{ instruction: string; label: string; kind: 'inline' | 'block' } | null>(null)
  const queue = useRef<EditJob[]>([])
  const inflight = useRef<AbortController | null>(null)
  const reverts = useRef(new Map<string, RevertInfo>())
  const lastRef = useRef<{ jobId: string; instruction: string; maxRatio?: number; useInstructions: boolean; useFiles: boolean } | null>(null)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const slugRef = useRef(slug)
  slugRef.current = slug

  // Reset on document switch.
  useEffect(() => {
    inflight.current?.abort()
    queue.current = []
    reverts.current.clear()
    lastRef.current = null
    setJobs([])
    setToast(null)
  }, [slug])

  const patchJob = (id: string, p: Partial<EditJob>) => setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)))

  const pump = useCallback(async () => {
    if (inflight.current) return
    const job = queue.current.shift()
    const ed = editorRef.current
    const docSlug = slugRef.current
    if (!job || !ed || !docSlug) return
    const ac = new AbortController()
    inflight.current = ac
    patchJob(job.id, { status: 'working' })
    try {
      // Re-capture against the CURRENT document (overlapping edits apply to updated text).
      const r = getRange(ed.state, job.id)
      if (!r || r.from >= r.to) throw new Error('The selected text no longer exists.')
      const cap = captureSel(ed, r.from, r.to)
      if (!cap) throw new Error('Could not capture the selection.')
      // The tracked range may have been re-resolved to block boundaries; keep the plugin in sync.
      ed.view.dispatch(trackRange(ed.state, { id: job.id, from: cap.from, to: cap.to, cls: 'ai-working' }))
      const plainAtSend = cap.plain
      let result: any = null
      await streamSse(`/api/docs/${docSlug}/edit`, {
        selection: cap.selection, context: cap.context, instruction: job.instruction, kind: cap.kind, maxRatio: job.maxRatio,
        useInstructions: job.useInstructions, useFiles: job.useFiles,
      }, (f: any) => {
        if (f.type === 'text') setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, preview: (f.attempt > 1 && j.preview.endsWith('…') ? '' : j.preview) + f.text } : j)))
        else if (f.type === 'result') result = f
        else if (f.type === 'error') result = { ok: false, reason: f.message }
      }, ac.signal)
      if (!result) throw new Error('No result from backend.')
      if (!result.ok) throw new Error(result.reason ?? 'Edit rejected.')
      // Remap and verify the span is still the same text before splicing.
      const now = getRange(ed.state, job.id)
      if (!now || now.from >= now.to) throw new Error('The selected text was removed while the edit was in flight.')
      const plainNow = ed.state.doc.textBetween(now.from, now.to, '\n', ' ')
      if (plainNow !== plainAtSend) throw new Error('The selected text was edited while the request was in flight; not applied.')
      const fragment = parseReplacement(ed, result.markdown, cap.kind)
      // Snapshot pre-edit state (one per AI edit), then apply as a single transaction.
      void api.snapshot(docSlug, `surgical-${cap.label}`, ed.getJSON())
      const applied = applySplice(ed, now.from, now.to, fragment, cap.kind)
      const newTo = now.from + applied.insertedSize
      // Two tracked ranges: a fading highlight, and a persistent invisible one that revert uses.
      ed.view.dispatch(trackRange(ed.state, { id: job.id, from: now.from, to: newTo, cls: 'ai-fresh' }))
      ed.view.dispatch(trackRange(ed.state, { id: job.id + '-applied', from: now.from, to: newTo, cls: 'ai-applied' }))
      window.setTimeout(() => { const e = editorRef.current; if (e && !e.isDestroyed) e.view.dispatch(untrackRange(e.state, job.id)) }, 4000)
      reverts.current.set(job.id, { id: job.id, kind: cap.kind, before: applied.before, label: cap.label, afterPlain: ed.state.doc.textBetween(now.from, newTo, '\n', ' ') })
      patchJob(job.id, { status: 'done', preview: result.markdown })
      setLastEdit({ instruction: job.instruction, label: cap.label, kind: cap.kind })
      lastRef.current = { jobId: job.id, instruction: job.instruction, maxRatio: job.maxRatio, useInstructions: job.useInstructions, useFiles: job.useFiles }
      const text = `✎ revised ${cap.label} (${job.instruction.slice(0, 40)}${job.instruction.length > 40 ? '…' : ''})${result.attempts > 1 ? ' · retried once' : ''}`
      setToast({ id: job.id, text: `Revised ${cap.label}`, revertId: job.id })
      window.setTimeout(() => setToast((t) => (t?.id === job.id ? null : t)), 8000)
      const entry = await api.addAction(docSlug, text, { kind: 'surgical', label: cap.label, revertable: true, jobId: job.id, before: applied.before, instruction: job.instruction })
      // Let the transcript know which entry id maps to which revert.
      reverts.current.set(entry.id, reverts.current.get(job.id)!)
      onActionRecord?.({ id: entry.id, text, revertable: true })
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'cancelled' : String(e?.message ?? e)
      patchJob(job.id, { status: 'failed', error: msg })
      const ed2 = editorRef.current
      if (ed2 && !ed2.isDestroyed) ed2.view.dispatch(untrackRange(ed2.state, job.id))
      if (msg !== 'cancelled') { setToast({ id: job.id, text: `Edit failed: ${msg}` }); window.setTimeout(() => setToast((t) => (t?.id === job.id ? null : t)), 8000) }
      if (docSlug && msg !== 'cancelled') void api.addAction(docSlug, `✗ edit of ${job.label} not applied: ${msg}`, { kind: 'surgical-failed' })
    } finally {
      inflight.current = null
      window.setTimeout(() => setJobs((js) => js.filter((j) => j.status === 'pending' || j.status === 'working' || Date.now() - Number(j.id.split('-')[1]) < 15000)), 15000)
      void pump()
    }
  }, [])

  /** Queue an edit for the given range. */
  const submit = useCallback((from: number, to: number, instruction: string, opts?: { maxRatio?: number; useInstructions?: boolean; useFiles?: boolean }) => {
    const ed = editorRef.current
    if (!ed || from === to) return
    const cap = captureSel(ed, from, to)
    if (!cap) return
    const id = `edit-${Date.now()}-${seq++}`
    ed.view.dispatch(trackRange(ed.state, { id, from: cap.from, to: cap.to, cls: 'ai-working' }))
    const job: EditJob = { id, instruction, maxRatio: opts?.maxRatio, useInstructions: opts?.useInstructions ?? true, useFiles: opts?.useFiles ?? false, status: 'pending', preview: '', label: cap.label }
    queue.current.push(job)
    setJobs((js) => [...js, job])
    void pump()
    return id
  }, [pump])

  const revert = useCallback((id: string) => {
    const ed = editorRef.current
    const info = reverts.current.get(id)
    if (!ed || !info) return false
    const r = getRange(ed.state, info.id + '-applied')
    const rvId = `rv-${Date.now()}`
    const flash = (text: string, ms: number) => { setToast({ id: rvId, text }); window.setTimeout(() => setToast((t) => (t?.id === rvId ? null : t)), ms) }
    if (!r || r.from >= r.to) { flash('Cannot revert: the revised text no longer exists.', 5000); return false }
    if (ed.state.doc.textBetween(r.from, r.to, '\n', ' ') !== info.afterPlain && !confirm('The revised text has been edited since. Revert anyway (your edits inside it will be lost)?')) return false
    const size = revertSplice(ed, r.from, r.to, info.before, info.kind)
    ed.view.dispatch(untrackRange(ed.state, info.id))
    ed.view.dispatch(untrackRange(ed.state, info.id + '-applied'))
    ed.view.dispatch(trackRange(ed.state, { id: info.id + '-rv', from: r.from, to: r.from + size, cls: 'ai-fresh' }))
    window.setTimeout(() => { const e = editorRef.current; if (e && !e.isDestroyed) e.view.dispatch(untrackRange(e.state, info.id + '-rv')) }, 3000)
    for (const [k, v] of reverts.current) if (v.id === info.id) reverts.current.delete(k)
    flash(`Reverted ${info.label}`, 4000)
    if (slugRef.current) void api.addAction(slugRef.current, `↶ reverted ${info.label}`, { kind: 'revert' })
    onActionRecord?.({ id: `local-rv-${Date.now()}`, text: `↶ reverted ${info.label}`, revertable: false })
    return true
  }, [])

  const canRevert = useCallback((id: string) => reverts.current.has(id), [])

  /**
   * "Now do the same to the next paragraph" (GOAL §7/§10): resolved here, not by the model.
   * Finds the top-level block after (or before) the last applied edit and re-submits the same
   * instruction as a fresh, fully explicit one-shot.
   */
  const followUp = useCallback((direction: 'next' | 'previous' = 'next'): string | null => {
    const ed = editorRef.current
    const last = lastRef.current
    if (!ed || !last) return null
    const r = getRange(ed.state, last.jobId + '-applied')
    if (!r) return null
    const doc = ed.state.doc
    let target: { from: number; to: number } | null = null
    doc.forEach((node, offset) => {
      const end = offset + node.nodeSize
      if (direction === 'next' && !target && offset >= r.to && node.isTextblock) target = { from: offset + 1, to: end - 1 }
      if (direction === 'previous' && end <= r.from && node.isTextblock) target = { from: offset + 1, to: end - 1 }
    })
    if (!target) return null
    const t = target as { from: number; to: number }
    if (t.from >= t.to) return null
    return submit(t.from, t.to, last.instruction, { maxRatio: last.maxRatio, useInstructions: last.useInstructions, useFiles: last.useFiles }) ?? null
  }, [])
  const cancel = useCallback((id: string) => {
    queue.current = queue.current.filter((j) => j.id !== id)
    const ed = editorRef.current
    if (ed) ed.view.dispatch(untrackRange(ed.state, id))
    setJobs((js) => js.filter((j) => j.id !== id))
  }, [])

  return { jobs, toast, submit, revert, canRevert, cancel, lastEdit, followUp, dismissToast: () => setToast(null) }
}

export type { Capture }
