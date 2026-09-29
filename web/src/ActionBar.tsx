import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'

export interface ActionBarProps {
  editor: Editor
  /** Non-empty selection to act on (captured at mouseup / keyup). */
  range: { from: number; to: number } | null
  hasFiles: boolean
  onSubmit: (from: number, to: number, instruction: string, opts: { maxRatio?: number; useInstructions: boolean; useFiles: boolean }) => void
  onClose: () => void
}

const QUICK: { label: string; instruction: string; maxRatio?: number }[] = [
  { label: 'Shorten', instruction: 'Make this more concise without losing meaning.', maxRatio: 1.5 },
  { label: 'Expand', instruction: 'Expand this with more detail and explanation, keeping the same voice.', maxRatio: 6 },
  { label: 'Rephrase', instruction: 'Rephrase this, keeping the same meaning and tone.' },
  { label: 'Fix tone', instruction: 'Fix the tone so it is clear, professional and consistent with the surrounding text.' },
  { label: 'Make a list', instruction: 'Turn this into a bulleted list of the key points.', maxRatio: 3 },
]

export function ActionBar({ editor, range, hasFiles, onSubmit, onClose }: ActionBarProps) {
  const [text, setText] = useState('')
  const [useInstructions, setUseInstructions] = useState(true)
  const [useFiles, setUseFiles] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!range) { setPos(null); return }
    try {
      const end = editor.view.coordsAtPos(range.to)
      const start = editor.view.coordsAtPos(range.from)
      const host = editor.view.dom.closest('.editor-scroll') as HTMLElement | null
      const hostRect = host?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth }
      const left = Math.max(8, Math.min(start.left - hostRect.left, hostRect.width - 400))
      const top = end.bottom - hostRect.top + (host?.scrollTop ?? 0) + 8
      setPos({ left, top })
    } catch { setPos(null) }
  }, [editor, range])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  if (!range || !pos) return null
  const go = (instruction: string, maxRatio?: number) => {
    if (!instruction.trim()) return
    onSubmit(range.from, range.to, instruction.trim(), { maxRatio, useInstructions, useFiles })
    setText('')
    onClose()
  }
  return (
    <div className="action-bar" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault() }}>
      <div className="quick">
        {QUICK.map((q) => <button key={q.label} type="button" onClick={() => go(q.instruction, q.maxRatio)}>{q.label}</button>)}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); go(text) }}>
        <input ref={inputRef} type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Instruction for the selected text… (Enter)" autoFocus />
        <button type="submit" className="primary" disabled={!text.trim()}>Go</button>
      </form>
      <div className="opts">
        <label><input type="checkbox" checked={useInstructions} onChange={(e) => setUseInstructions(e.target.checked)} /> standing instructions</label>
        <label title={hasFiles ? 'Include this document\'s reference files' : 'No reference files attached'}><input type="checkbox" checked={useFiles} disabled={!hasFiles} onChange={(e) => setUseFiles(e.target.checked)} /> reference files</label>
        <span style={{ marginLeft: 'auto' }}>Esc to close</span>
      </div>
    </div>
  )
}
