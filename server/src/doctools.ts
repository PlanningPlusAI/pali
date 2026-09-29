// Chat-lane document tools (GOAL §7 "Chat-driven document editing").
// The frontend sends the document as top-level blocks with stable ids each turn; the model
// addresses blocks by id; every tool call is validated here, mirrored into `ctx.blocks`
// (so later calls in the same turn see the new state) and forwarded to the frontend as a
// `doc_edit` frame, which applies it as one transaction with a history snapshot + revert.
import { z } from 'zod'
import type { CustomTool } from './provider/types.js'

export interface Block { id: string; md: string }

export interface DocEdit {
  type: 'doc_edit'
  op: 'replace_block' | 'replace_range' | 'insert_after' | 'insert_at_end' | 'delete_range'
  fromId?: string
  toId?: string
  /** Ids assigned to newly created blocks (the frontend mirrors these). */
  newIds?: string[]
  markdown?: string
  summary: string
}

export interface TurnContext {
  blocks: Block[]
  emit: (e: DocEdit) => void
  newSeq: number
  edits: number
}

const SENTINEL = /⟦\/?SEL⟧/

function idx(ctx: TurnContext, id: string): number {
  const i = ctx.blocks.findIndex((b) => b.id === id)
  if (i < 0) throw new Error(`Unknown block id "${id}". Call read_document to see current ids.`)
  return i
}

function splitBlocks(md: string): string[] {
  // Split on blank lines, keeping fenced code / $$ math together.
  const out: string[] = []
  let cur: string[] = []
  let fence: string | null = null
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    const f = /^(```|~~~|\$\$)/.exec(line.trim())
    if (f) {
      if (!fence) fence = f[1]
      else if (fence === f[1]) fence = null
      cur.push(line)
      continue
    }
    if (!fence && line.trim() === '') { if (cur.length) { out.push(cur.join('\n')); cur = [] } }
    else cur.push(line)
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

function checkMarkdown(md: unknown): string {
  const s = String(md ?? '').trim()
  if (!s) throw new Error('markdown must not be empty')
  if (SENTINEL.test(s)) throw new Error('markdown contains reserved sentinel markers')
  if (s.length > 20000) throw new Error('markdown too long for a single edit')
  return s
}

export function renderDocument(blocks: Block[]): string {
  if (!blocks.length) return '(empty document)'
  return blocks.map((b) => `[${b.id}]\n${b.md}`).join('\n\n')
}

/** Builds the six document tools bound to a mutable per-turn context. */
export function makeDocTools(ctx: TurnContext): CustomTool[] {
  const ok = (text: string) => ({ ok: true, text })
  const fail = (e: unknown) => ({ ok: false, text: `Error: ${(e as Error).message ?? e}` })
  const newId = () => `n${++ctx.newSeq}`
  const insertBlocks = (at: number, md: string, edit: Omit<DocEdit, 'newIds' | 'type' | 'summary'>, summary: string) => {
    const parts = splitBlocks(md)
    const ids = parts.map(() => newId())
    ctx.blocks.splice(at, 0, ...parts.map((p, i) => ({ id: ids[i], md: p })))
    ctx.edits++
    ctx.emit({ type: 'doc_edit', ...edit, newIds: ids, markdown: md, summary })
    return ids
  }

  return [
    {
      name: 'read_document',
      description: 'Returns the current document as markdown, one top-level block per [id]. Use the ids with the other tools. Always call this before editing if you have not seen the current document in this turn.',
      schema: {},
      handler: async () => ok(renderDocument(ctx.blocks)),
    },
    {
      name: 'replace_block',
      description: 'Replace one block (by id) with new markdown. The markdown may contain several blocks separated by blank lines.',
      schema: { id: z.string().describe('block id, e.g. b3'), markdown: z.string().describe('replacement markdown') },
      handler: async ({ id, markdown }: { id: string; markdown: string }) => {
        try {
          const i = idx(ctx, id)
          const md = checkMarkdown(markdown)
          const parts = splitBlocks(md)
          const ids = parts.map((_, k) => (k === 0 ? id : newId()))
          ctx.blocks.splice(i, 1, ...parts.map((p, k) => ({ id: ids[k], md: p })))
          ctx.edits++
          ctx.emit({ type: 'doc_edit', op: 'replace_block', fromId: id, newIds: ids, markdown: md, summary: `replaced ${id}` })
          return ok(`Replaced ${id}${ids.length > 1 ? ` (now ${ids.join(', ')})` : ''}.`)
        } catch (e) { return fail(e) }
      },
    },
    {
      name: 'replace_range',
      description: 'Replace a contiguous range of blocks, from from_id through to_id inclusive, with new markdown.',
      schema: { from_id: z.string(), to_id: z.string(), markdown: z.string() },
      handler: async ({ from_id, to_id, markdown }: { from_id: string; to_id: string; markdown: string }) => {
        try {
          const a = idx(ctx, from_id); const b = idx(ctx, to_id)
          if (b < a) throw new Error('to_id comes before from_id')
          const md = checkMarkdown(markdown)
          const parts = splitBlocks(md)
          const ids = parts.map((_, k) => (k === 0 ? from_id : newId()))
          ctx.blocks.splice(a, b - a + 1, ...parts.map((p, k) => ({ id: ids[k], md: p })))
          ctx.edits++
          ctx.emit({ type: 'doc_edit', op: 'replace_range', fromId: from_id, toId: to_id, newIds: ids, markdown: md, summary: `replaced ${from_id}–${to_id}` })
          return ok(`Replaced ${from_id}–${to_id} with ${ids.length} block(s): ${ids.join(', ')}.`)
        } catch (e) { return fail(e) }
      },
    },
    {
      name: 'insert_after',
      description: 'Insert new markdown after the block with the given id.',
      schema: { id: z.string(), markdown: z.string() },
      handler: async ({ id, markdown }: { id: string; markdown: string }) => {
        try {
          const i = idx(ctx, id)
          const md = checkMarkdown(markdown)
          const ids = insertBlocks(i + 1, md, { op: 'insert_after', fromId: id }, `inserted after ${id}`)
          return ok(`Inserted ${ids.length} block(s) after ${id}: ${ids.join(', ')}.`)
        } catch (e) { return fail(e) }
      },
    },
    {
      name: 'insert_at_end',
      description: 'Append new markdown at the end of the document.',
      schema: { markdown: z.string() },
      handler: async ({ markdown }: { markdown: string }) => {
        try {
          const md = checkMarkdown(markdown)
          const ids = insertBlocks(ctx.blocks.length, md, { op: 'insert_at_end' }, 'appended at end')
          return ok(`Appended ${ids.length} block(s): ${ids.join(', ')}.`)
        } catch (e) { return fail(e) }
      },
    },
    {
      name: 'delete_range',
      description: 'Delete a contiguous range of blocks, from from_id through to_id inclusive. Use the same id for both to delete one block.',
      schema: { from_id: z.string(), to_id: z.string() },
      handler: async ({ from_id, to_id }: { from_id: string; to_id: string }) => {
        try {
          const a = idx(ctx, from_id); const b = idx(ctx, to_id)
          if (b < a) throw new Error('to_id comes before from_id')
          ctx.blocks.splice(a, b - a + 1)
          ctx.edits++
          ctx.emit({ type: 'doc_edit', op: 'delete_range', fromId: from_id, toId: to_id, summary: `deleted ${from_id === to_id ? from_id : `${from_id}–${to_id}`}` })
          return ok(`Deleted ${from_id === to_id ? from_id : `${from_id}–${to_id}`}.`)
        } catch (e) { return fail(e) }
      },
    },
  ]
}

export const CHAT_TOOLS_GUIDE = `Document tools (use these to change the document; never paste document text into your reply):
- read_document() → the document as blocks with ids like [b3]
- replace_block(id, markdown), replace_range(from_id, to_id, markdown)
- insert_after(id, markdown), insert_at_end(markdown), delete_range(from_id, to_id)
Block ids are given in the "Current document" section of each message; new blocks you create get ids like n1. A "section" means a heading block plus every block up to the next heading of the same or higher level.
Make exactly the change the user asked for and nothing else: do not renumber, retitle, reformat or "fix" other blocks unless asked. Prefer the fewest tool calls that do the job (one delete_range for a section, one insert_at_end for a new section). After using tools, reply with one short sentence saying what you changed — do not repeat the new text.`
