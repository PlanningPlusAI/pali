// Surgical lane: prompt assembly + strict output validation (GOAL §7 steps 3–5).
import type { Frame, Provider } from './provider/types.js'
import { surgicalSystem } from './prompts.js'

export interface EditRequest {
  selection: string // selected text as markdown
  context: string // surrounding window with ⟦SEL⟧…⟦/SEL⟧ sentinels
  instruction: string
  kind: 'inline' | 'block'
  /** Allowed growth factor vs. selection length (quick action "Expand" raises it). */
  maxRatio?: number
  model: string
  standing: string // attached instruction sets block ('' to skip)
  files?: string // optional reference-file block (Phase 5)
  signal: AbortSignal
}

export interface EditResult {
  ok: boolean
  markdown: string
  attempts: number
  reason?: string
  raw: string[]
}

const PREAMBLE = /^\s*(sure|certainly|of course|absolutely|okay|ok\b|here(?:'s| is| are)\b|below is|i(?:'ve| have) (?:revised|rewritten|shortened|expanded|rephrased|updated)|the (?:revised|rewritten|shortened|expanded|updated) (?:text|version|paragraph|sentence))/i
const TRAILER = /(let me know|hope (?:this|that) helps|feel free to|would you like|if you(?:'d| would) like)[^\n]*\s*$/i
const BLOCKISH = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?|```|\$\$|---\s*$)/m

export function stripFences(s: string) {
  let t = s.trim()
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(t)
  if (m) t = m[1].trim()
  return t
}

export function validate(output: string, req: Pick<EditRequest, 'selection' | 'kind' | 'maxRatio' | 'instruction'>): { ok: true; text: string } | { ok: false; reason: string } {
  const text = stripFences(output)
  if (!text) return { ok: false, reason: 'empty output' }
  if (PREAMBLE.test(text)) return { ok: false, reason: 'starts with a preamble (e.g. "Sure", "Here is")' }
  if (TRAILER.test(text) && !TRAILER.test(req.selection)) return { ok: false, reason: 'ends with a conversational trailer' }
  const ratio = req.maxRatio ?? 3
  const cap = Math.max(req.selection.length * ratio, req.selection.length + 400)
  if (text.length > cap) return { ok: false, reason: `output is implausibly long (${text.length} chars vs selection ${req.selection.length}; cap ${Math.round(cap)})` }
  if (req.kind === 'inline') {
    if (/\n\s*\n/.test(text)) return { ok: false, reason: 'inline replacement contains a paragraph break' }
    if (BLOCKISH.test(text) && !BLOCKISH.test(req.selection)) return { ok: false, reason: 'inline replacement contains a block construct (heading/list/quote/fence)' }
  }
  // Echoing the whole context back is a classic failure.
  if (text.length > req.selection.length * 1.5 && text.includes('⟦')) return { ok: false, reason: 'output contains sentinel markers' }
  return { ok: true, text }
}

export function buildUserMessage(req: Pick<EditRequest, 'selection' | 'context' | 'instruction' | 'kind' | 'files'>, corrective?: string) {
  const parts = [
    `Selection kind: ${req.kind.toUpperCase()}.`,
    `Context (the selection is delimited by ⟦SEL⟧ and ⟦/SEL⟧; everything outside is for reference only and must not be returned):`,
    '"""',
    req.context,
    '"""',
    '',
    'Selected text (this is what you replace):',
    '"""',
    req.selection,
    '"""',
    '',
    `Instruction: ${req.instruction}`,
  ]
  if (req.files) parts.push('', req.files)
  if (corrective) parts.push('', `IMPORTANT — your previous attempt was rejected: ${corrective}. Return only the replacement text for the selection, nothing else.`)
  parts.push('', 'Return only the replacement for the selected text.')
  return parts.join('\n')
}

/**
 * Runs the one-shot, validates, retries once with a corrective note. Streams text deltas to onDelta
 * (preview only — the document is never touched with unvalidated output).
 */
export async function runEdit(provider: Provider, req: EditRequest, onDelta: (t: string, attempt: number) => void, onPrompt?: (system: string, prompt: string) => void): Promise<EditResult> {
  const system = surgicalSystem(req.standing)
  const raw: string[] = []
  let reason = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildUserMessage(req, attempt > 1 ? reason : undefined)
    onPrompt?.(system, prompt)
    let text = ''
    let errored: string | null = null
    for await (const f of provider.oneShot({ system, prompt, model: req.model, signal: req.signal })) {
      if (f.type === 'text') { text += f.text; onDelta(f.text, attempt) }
      else if (f.type === 'done') { if (f.isError) errored = f.text || 'model error'; if (!text) text = f.text }
      else if (f.type === 'error') errored = f.message
    }
    raw.push(text)
    if (req.signal.aborted) return { ok: false, markdown: '', attempts: attempt, reason: 'cancelled', raw }
    if (errored) return { ok: false, markdown: '', attempts: attempt, reason: errored, raw }
    const v = validate(text, req)
    if (v.ok) return { ok: true, markdown: v.text, attempts: attempt, raw }
    reason = v.reason
  }
  return { ok: false, markdown: '', attempts: 2, reason: `rejected after retry: ${reason}`, raw }
}

export type { Frame }
