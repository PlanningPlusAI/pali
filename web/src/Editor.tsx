import { useEffect, useRef } from 'react'
import type React from 'react'
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { BlockMath } from '@tiptap/extension-mathematics'
import 'katex/dist/katex.min.css'
import { SurgicalExtension } from './surgical/plugin'

// Inline math ($…$) is deliberately not registered: it misfired on currency and plain "$".
export const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
  Markdown,
  BlockMath.configure({ katexOptions: { throwOnError: false } }),
  SurgicalExtension,
]

/** Older documents may contain inlineMath nodes; turn them back into literal "$…$" text. */
export function stripInlineMath(json: any): any {
  if (!json || typeof json !== 'object') return json
  if (!Array.isArray(json.content)) return json
  const content: any[] = []
  for (const c of json.content) {
    if (c?.type === 'inlineMath') {
      const text = `$${c.attrs?.latex ?? ''}$`
      const prev = content[content.length - 1]
      if (prev?.type === 'text' && !prev.marks) content[content.length - 1] = { ...prev, text: prev.text + text }
      else content.push({ type: 'text', text })
    } else content.push(stripInlineMath(c))
  }
  return { ...json, content }
}

export interface EditorProps {
  slug: string | null
  initialJson: unknown | null
  initialMarkdown: string
  readOnly: boolean
  onSave: (json: unknown, markdown: string, slug: string) => void
  onReady?: (editor: TiptapEditor) => void
  /** Called on every editor transaction (Phase 3 uses this for selection). */
  onTransaction?: (editor: TiptapEditor) => void
  /** Non-empty selection changes (Phase 3 action bar). */
  onSelection?: (range: { from: number; to: number } | null) => void
  /** Download the live document as .docx. */
  onExportWord?: (json: unknown) => void
  /** Rendered inside the scrolling editor area (floating UI). */
  overlay?: React.ReactNode
}

const AUTOSAVE_MS = 700

export function Editor(props: EditorProps) {
  const { slug, initialJson, initialMarkdown, readOnly, onSave, onReady, onTransaction, onSelection, onExportWord, overlay } = props
  const selRef = useRef(onSelection)
  selRef.current = onSelection
  const timer = useRef<number | null>(null)
  const dirty = useRef(false)
  const loadedSlug = useRef<string | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  const editor = useEditor({
    extensions,
    content: '',
    editable: !readOnly,
    editorProps: { attributes: { class: 'doc-editor', spellcheck: 'true' } },
    onUpdate: ({ editor }) => {
      if (loadedSlug.current !== slug) return
      dirty.current = true
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => flush(editor), AUTOSAVE_MS)
    },
    onTransaction: ({ editor }) => onTransaction?.(editor),
    onSelectionUpdate: ({ editor }) => {
      const { from, to, empty } = editor.state.selection
      selRef.current?.(empty ? null : { from, to })
    },
  })

  function flush(ed: TiptapEditor) {
    if (!dirty.current || !loadedSlug.current) return
    dirty.current = false
    if (timer.current) window.clearTimeout(timer.current)
    // Pass the slug whose content is in the editor: on a document switch the parent has already moved on.
    saveRef.current(ed.getJSON(), ed.getMarkdown(), loadedSlug.current)
  }

  // Load content when the document changes; flush the previous one first.
  useEffect(() => {
    if (!editor) return
    if (loadedSlug.current && loadedSlug.current !== slug) flush(editor)
    loadedSlug.current = null
    if (initialJson) editor.commands.setContent(stripInlineMath(initialJson), { emitUpdate: false })
    else if (initialMarkdown) editor.commands.setContent(initialMarkdown, { contentType: 'markdown', emitUpdate: false } as any)
    else editor.commands.clearContent(false)
    loadedSlug.current = slug
    dirty.current = false
    onReady?.(editor)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, slug])

  useEffect(() => { editor?.setEditable(!readOnly) }, [editor, readOnly])

  // Flush on unload / unmount so nothing is lost on refresh (GOAL §6).
  useEffect(() => {
    if (!editor) return
    const h = () => { if (timer.current) window.clearTimeout(timer.current); flush(editor) }
    window.addEventListener('beforeunload', h)
    window.addEventListener('pagehide', h)
    return () => { h(); window.removeEventListener('beforeunload', h); window.removeEventListener('pagehide', h) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  if (!editor) return null
  return (
    <div className="editor-wrap">
      <Toolbar editor={editor} disabled={readOnly} onExportWord={onExportWord} />
      <div className="editor-scroll">
        <EditorContent editor={editor} />
        {overlay}
      </div>
    </div>
  )
}

// Word's built-in paragraph styles, in gallery order.
const STYLES: { value: string; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'h1', label: 'Heading 1' },
  { value: 'h2', label: 'Heading 2' },
  { value: 'h3', label: 'Heading 3' },
  { value: 'h4', label: 'Heading 4' },
  { value: 'h5', label: 'Heading 5' },
  { value: 'h6', label: 'Heading 6' },
  { value: 'bullet', label: 'List Bullet' },
  { value: 'number', label: 'List Number' },
  { value: 'quote', label: 'Quote' },
  { value: 'code', label: 'Code' },
]

/** The paragraph style at the cursor: the text block's own type, else the innermost list/quote around it. */
function styleAt(ed: TiptapEditor): string {
  const $f = ed.state.selection.$from
  const tb = $f.parent
  if (tb.type.name === 'heading') return `h${tb.attrs.level}`
  if (tb.type.name === 'codeBlock') return 'code'
  if (tb.type.name === 'blockMath') return 'normal'
  for (let d = $f.depth; d > 0; d--) {
    const n = $f.node(d).type.name
    if (n === 'bulletList') return 'bullet'
    if (n === 'orderedList') return 'number'
    if (n === 'blockquote') return 'quote'
  }
  return 'normal'
}

function applyStyle(ed: TiptapEditor, style: string) {
  // clearNodes resets to Normal (lifting out of lists/quotes) so every style starts from a clean paragraph.
  const c = ed.chain().focus().clearNodes()
  if (style.startsWith('h')) c.setHeading({ level: Number(style.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6 })
  else if (style === 'bullet') c.toggleBulletList()
  else if (style === 'number') c.toggleOrderedList()
  else if (style === 'quote') c.toggleBlockquote()
  else if (style === 'code') c.toggleCodeBlock()
  c.run()
}

function Toolbar({ editor, disabled, onExportWord }: { editor: TiptapEditor; disabled: boolean; onExportWord?: (json: unknown) => void }) {
  // useEditor does not re-render on transactions, so subscribe to exactly the state the toolbar shows.
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      style: styleAt(e),
      bold: e.isActive('bold'), italic: e.isActive('italic'), underline: e.isActive('underline'), strike: e.isActive('strike'), code: e.isActive('code'),
      bulletList: e.isActive('bulletList'), orderedList: e.isActive('orderedList'), blockquote: e.isActive('blockquote'), codeBlock: e.isActive('codeBlock'),
      blockMath: e.isActive('blockMath'),
    }),
  })
  const b = (label: React.ReactNode, title: string, active: boolean, run: () => void) => (
    <button type="button" title={title} className={active ? 'tb active' : 'tb'} disabled={disabled} onMouseDown={(e) => { e.preventDefault(); run() }}>{label}</button>
  )
  // Fresh chain per click: a chain accumulates commands, so reusing one replays earlier ones.
  const c = () => editor.chain().focus()
  const note = (msg: string) => { const el = document.querySelector('.toolbar .copied'); if (el) { el.textContent = msg; window.setTimeout(() => { el.textContent = '' }, 2000) } }
  return (
    <div className="toolbar">
      <select className="style-select" title="Paragraph style" value={s.style} disabled={disabled}
        onChange={(e) => applyStyle(editor, e.target.value)}>
        {STYLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="tb-sep" />
      {b(<b>B</b>, 'Bold (Ctrl+B)', s.bold, () => c().toggleBold().run())}
      {b(<i>I</i>, 'Italic (Ctrl+I)', s.italic, () => c().toggleItalic().run())}
      {b(<u>U</u>, 'Underline (Ctrl+U)', s.underline, () => c().toggleUnderline().run())}
      {b(<s>S</s>, 'Strikethrough', s.strike, () => c().toggleStrike().run())}
      {b('<>', 'Inline code', s.code, () => c().toggleCode().run())}
      <span className="tb-sep" />
      {b('• List', 'Bulleted list', s.bulletList, () => c().toggleBulletList().run())}
      {b('1. List', 'Numbered list', s.orderedList, () => c().toggleOrderedList().run())}
      {b('❝', 'Quote', s.blockquote, () => c().toggleBlockquote().run())}
      {b('{ }', 'Code block', s.codeBlock, () => c().toggleCodeBlock().run())}
      {b('∫', 'Display math ($$…$$)', s.blockMath, () => {
        const latex = window.prompt('LaTeX (display):', '\\int_0^1 x^2\\,dx = \\frac13')
        if (latex) (editor.chain().focus() as any).insertBlockMath({ latex }).run()
      })}
      <span className="tb-sep" />
      {b('↶', 'Undo (Ctrl+Z)', false, () => c().undo().run())}
      {b('↷', 'Redo (Ctrl+Y)', false, () => c().redo().run())}
      <span className="tb-sep" />
      {b('⧉ Copy', 'Copy the whole document as rich text (pastes formatted into Word, Docs, mail)', false, () => {
        const html = editor.getHTML()
        const text = editor.getText({ blockSeparator: '\n\n' })
        const done = () => note('Copied as rich text')
        if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
          navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]).then(done).catch(() => navigator.clipboard.writeText(text).then(done))
        } else { void navigator.clipboard?.writeText(text).then(done) }
      })}
      {b('⧉ MD', 'Copy the whole document as markdown', false, () => {
        void navigator.clipboard?.writeText(editor.getMarkdown()).then(() => note('Copied as markdown'))
      })}
      {onExportWord && <button type="button" className="tb" title="Download as a Word document (.docx) with Word styles" onMouseDown={(e) => { e.preventDefault(); onExportWord(editor.getJSON()) }}>⬇ Word</button>}
      <span className="copied muted" style={{ fontSize: 12, alignSelf: 'center' }} />
    </div>
  )
}
