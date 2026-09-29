// Selection capture (GOAL §7 step 2): kind, markdown of the selection, and a
// context window with sentinel markers — all derived from the same markdown
// serialization so what the model sees matches what we splice.
import type { Editor } from '@tiptap/react'
import type { EditorState } from '@tiptap/pm/state'

export const SEL_OPEN = '⟦SEL⟧'
export const SEL_CLOSE = '⟦/SEL⟧'
const WINDOW = 500

export interface Capture {
  kind: 'inline' | 'block'
  from: number
  to: number
  selection: string
  context: string
  /** Human label for action records, e.g. "¶3" or "H2 'Methods'". */
  label: string
  /** Plain text of the selected range, used to detect in-flight edits inside the span. */
  plain: string
}

/** Resolve the selection to a range + kind. Full top-level blocks become block-level. */
export function resolveRange(state: EditorState, from: number, to: number): { kind: 'inline' | 'block'; from: number; to: number } {
  const $from = state.doc.resolve(from)
  const $to = state.doc.resolve(to)
  const sameTextblock = $from.sameParent($to) && $from.parent.isTextblock
  if (sameTextblock) {
    const wholeBlock = from === $from.start() && to === $from.end()
    const topLevel = $from.depth === 1
    if (!(wholeBlock && topLevel)) return { kind: 'inline', from, to }
  }
  // Block-level: expand to the top-level blocks covering the range.
  const startIdx = $from.index(0)
  const endIdx = Math.max(startIdx, $to.index(0) - (to === $to.before(1) && to > from ? 1 : 0))
  let bFrom = 0
  let bTo = 0
  let pos = 0
  state.doc.forEach((node, offset, index) => {
    if (index === startIdx) bFrom = offset
    if (index === endIdx) bTo = offset + node.nodeSize
    pos = offset + node.nodeSize
  })
  if (bTo === 0) bTo = pos
  return { kind: 'block', from: bFrom, to: bTo }
}

export function blockLabel(state: EditorState, pos: number): string {
  const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size))
  // index(0) is the top-level child containing (or, at depth 0, following) the position.
  const idx = Math.min($pos.index(0), state.doc.childCount - 1)
  const node = state.doc.maybeChild(idx)
  if (node?.type.name === 'heading') return `H${node.attrs.level} '${node.textContent.slice(0, 30)}'`
  return `¶${idx + 1}`
}

export function capture(editor: Editor, from: number, to: number): Capture | null {
  const state = editor.state
  if (from === to) return null
  const r = resolveRange(state, from, to)
  const schema = state.schema
  // Insert sentinels into a scratch transaction (never dispatched), then serialize.
  const tr = state.tr
  if (r.kind === 'inline') {
    tr.insert(r.to, schema.text(SEL_CLOSE))
    tr.insert(r.from, schema.text(SEL_OPEN))
  } else {
    tr.insert(r.to, schema.nodes.paragraph.create(null, schema.text(SEL_CLOSE)))
    tr.insert(r.from, schema.nodes.paragraph.create(null, schema.text(SEL_OPEN)))
  }
  const md = editor.markdown!.serialize(tr.doc.toJSON())
  const a = md.indexOf(SEL_OPEN)
  const b = md.indexOf(SEL_CLOSE)
  if (a < 0 || b < 0 || b < a) return null
  const selection = md.slice(a + SEL_OPEN.length, b).trim()
  if (!selection) return null
  // Context: containing block(s) ± WINDOW chars, extended to line boundaries.
  let cStart = Math.max(0, a - WINDOW)
  let cEnd = Math.min(md.length, b + SEL_CLOSE.length + WINDOW)
  cStart = md.lastIndexOf('\n\n', cStart)
  cStart = cStart < 0 ? 0 : cStart + 2
  const nl = md.indexOf('\n\n', cEnd)
  cEnd = nl < 0 ? md.length : nl
  const context = md.slice(cStart, cEnd).trim()
  return { kind: r.kind, from: r.from, to: r.to, selection, context, label: blockLabel(state, r.from), plain: state.doc.textBetween(r.from, r.to, '\n', ' ') }
}
