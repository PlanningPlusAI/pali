// Markdown → nodes → single-transaction splice (GOAL §7 step 6), and exact revert.
import type { Editor } from '@tiptap/react'
import { Fragment, Node as PMNode, Slice } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'

/** Parse reply markdown into PM nodes matching the selection kind. */
export function parseReplacement(editor: Editor, markdown: string, kind: 'inline' | 'block'): Fragment {
  const schema = editor.schema
  const json: JSONContent = editor.markdown!.parse(markdown)
  const blocks = (json.content ?? []).map((b) => PMNode.fromJSON(schema, b))
  if (kind === 'block') return Fragment.from(blocks.length ? blocks : [schema.nodes.paragraph.create()])
  // Inline: flatten every block's inline content into one run, separated by a space.
  const inline: PMNode[] = []
  blocks.forEach((b, i) => {
    if (i > 0 && inline.length) inline.push(schema.text(' '))
    if (b.isTextblock) b.content.forEach((n) => inline.push(n))
    else if (b.isInline) inline.push(b)
    else if (b.textContent) inline.push(schema.text(b.textContent))
  })
  return Fragment.from(inline)
}

export interface Applied {
  /** JSON of the exact nodes that were replaced (for revert). */
  before: JSONContent[]
  /** Length of the inserted content, to track the new range. */
  insertedSize: number
}

/**
 * Replace [from,to) with `fragment` as ONE transaction. Returns the prior slice for revert.
 * The range must already be remapped by the caller.
 */
export function applySplice(editor: Editor, from: number, to: number, fragment: Fragment, _kind: 'inline' | 'block'): Applied {
  const { state, view } = editor
  const prior = state.doc.slice(from, to)
  const before = fragmentToJson(prior.content)
  const tr = state.tr.replaceWith(from, to, fragment)
  tr.setMeta('surgicalApply', true)
  view.dispatch(tr)
  return { before, insertedSize: fragment.size }
}

export function revertSplice(editor: Editor, from: number, to: number, before: JSONContent[], _kind: 'inline' | 'block') {
  const { state, view } = editor
  const nodes = before.map((j) => PMNode.fromJSON(state.schema, j))
  const frag = Fragment.from(nodes)
  const tr = state.tr.replaceWith(from, to, frag)
  tr.setMeta('surgicalRevert', true)
  view.dispatch(tr)
  return frag.size
}

function fragmentToJson(f: Fragment): JSONContent[] {
  const out: JSONContent[] = []
  f.forEach((n) => out.push(n.toJSON()))
  return out
}

export { Slice }
