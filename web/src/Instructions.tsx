import { useEffect, useState } from 'react'
import { api, type InstructionSet } from './api'

interface Props {
  attached: string[]
  onChange: (names: string[]) => void
  onClose: () => void
}

/** Library picker + editor for instruction sets (GOAL §9). */
export function InstructionsPicker({ attached, onChange, onClose }: Props) {
  const [sets, setSets] = useState<InstructionSet[]>([])
  const [editing, setEditing] = useState<{ name: string; body: string; isNew: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const reload = () => api.instructions().then(setSets).catch((e) => setErr(e.message))
  useEffect(() => { void reload() }, [])

  const toggle = (name: string) => onChange(attached.includes(name) ? attached.filter((n) => n !== name) : [...attached, name])
  const move = (name: string, dir: -1 | 1) => {
    const i = attached.indexOf(name); const j = i + dir
    if (i < 0 || j < 0 || j >= attached.length) return
    const a = [...attached]; [a[i], a[j]] = [a[j], a[i]]; onChange(a)
  }

  async function save() {
    if (!editing) return
    try { await api.saveInstruction(editing.name, editing.body); setEditing(null); await reload() }
    catch (e: any) { setErr(e.message) }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Instruction sets</strong>
          <span className="muted">Files in <code>instructions/</code>. Editing a set changes every document that attaches it.</span>
          <button className="icon" onClick={onClose}>✕</button>
        </div>
        {err && <div className="error">{err}</div>}
        {editing ? (
          <div className="instr-edit">
            <label>Name (file name)
              <input value={editing.name} disabled={!editing.isNew} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. concise-style" />
            </label>
            <label>Instruction text (first line may be a <code># Title</code>)
              <textarea rows={14} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            </label>
            <div className="row">
              <button className="primary" onClick={save} disabled={!editing.name.trim()}>Save</button>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div className="instr-list">
              {sets.length === 0 && <div className="muted pad">No instruction sets yet. Create one, or drop a <code>.md</code> file into the instructions folder.</div>}
              {sets.map((s) => {
                const on = attached.includes(s.name)
                return (
                  <div key={s.name} className={`instr-item ${on ? 'on' : ''}`}>
                    <label className="instr-check">
                      <input type="checkbox" checked={on} onChange={() => toggle(s.name)} />
                      <span className="instr-title">{s.title}</span>
                      <span className="muted">{s.name}.md</span>
                    </label>
                    <div className="instr-preview">{s.body.replace(/^#.*\n/, '').trim().slice(0, 160)}</div>
                    <div className="row small">
                      {on && <button onClick={() => move(s.name, -1)} title="Earlier in prompt">↑</button>}
                      {on && <button onClick={() => move(s.name, 1)} title="Later in prompt">↓</button>}
                      <button onClick={() => setEditing({ name: s.name, body: s.body, isNew: false })}>Edit</button>
                      <button onClick={() => api.duplicateInstruction(s.name).then(reload)}>Duplicate</button>
                      <button className="danger" onClick={() => { if (confirm(`Delete "${s.name}"?`)) api.deleteInstruction(s.name).then(() => { onChange(attached.filter((n) => n !== s.name)); return reload() }) }}>Delete</button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="row">
              <button className="primary" onClick={() => setEditing({ name: '', body: '# My style\n\n', isNew: true })}>+ New instruction set</button>
              <button onClick={reload}>Rescan folder</button>
              <span className="muted">Attached order = prompt order: {attached.join(' → ') || 'none'}</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
