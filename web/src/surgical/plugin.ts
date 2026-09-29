// ProseMirror plugin: tracks ranges through every transaction (GOAL §5 position mapping)
// and draws "working" / "fresh" decorations that move with the text.
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Extension } from '@tiptap/core'

export interface TrackedRange { id: string; from: number; to: number; cls: string }

interface PluginState { decos: DecorationSet; ranges: Map<string, TrackedRange> }

export const surgicalKey = new PluginKey<PluginState>('surgical')

type Meta = { add: TrackedRange } | { remove: string } | { set: TrackedRange }

function build(ranges: Map<string, TrackedRange>, doc: EditorState['doc']) {
  const decos: Decoration[] = []
  for (const r of ranges.values()) {
    if (r.from >= r.to) continue
    decos.push(Decoration.inline(r.from, r.to, { class: r.cls }))
  }
  return DecorationSet.create(doc, decos)
}

export const surgicalPlugin = new Plugin<PluginState>({
  key: surgicalKey,
  state: {
    init: () => ({ decos: DecorationSet.empty, ranges: new Map() }),
    apply(tr: Transaction, prev: PluginState, _old, newState) {
      let ranges = prev.ranges
      let changed = false
      if (tr.docChanged) {
        ranges = new Map()
        for (const r of prev.ranges.values()) {
          // Map start with +1 bias and end with -1 bias so typing at the edges stays outside the range.
          const from = tr.mapping.map(r.from, 1)
          const to = tr.mapping.map(r.to, -1)
          ranges.set(r.id, { ...r, from: Math.min(from, to), to: Math.max(from, to) })
        }
        changed = true
      }
      const meta = tr.getMeta(surgicalKey) as Meta | undefined
      if (meta) {
        if (ranges === prev.ranges) ranges = new Map(prev.ranges)
        if ('add' in meta) ranges.set(meta.add.id, meta.add)
        else if ('set' in meta) ranges.set(meta.set.id, meta.set)
        else if ('remove' in meta) ranges.delete(meta.remove)
        changed = true
      }
      if (!changed) return prev
      return { ranges, decos: build(ranges, newState.doc) }
    },
  },
  props: { decorations: (state) => surgicalKey.getState(state)?.decos ?? null },
})

export const SurgicalExtension = Extension.create({
  name: 'surgicalTracking',
  addProseMirrorPlugins() { return [surgicalPlugin] },
})

export function trackRange(state: EditorState, r: TrackedRange): Transaction {
  return state.tr.setMeta(surgicalKey, { add: r } satisfies Meta).setMeta('addToHistory', false)
}
export function untrackRange(state: EditorState, id: string): Transaction {
  return state.tr.setMeta(surgicalKey, { remove: id } satisfies Meta).setMeta('addToHistory', false)
}
export function getRange(state: EditorState, id: string): TrackedRange | undefined {
  return surgicalKey.getState(state)?.ranges.get(id)
}
