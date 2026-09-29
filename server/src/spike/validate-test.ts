// Unit checks for the surgical output validator (GOAL §7 step 5). Run: npx tsx src/spike/validate-test.ts
import { validate, stripFences } from '../surgical.js'

const sel = 'The mayor responded by outlining a plan that would, over the course of the next three years, gradually phase in new development incentives.'
const cases: { name: string; out: string; kind: 'inline' | 'block'; expectOk: boolean }[] = [
  { name: 'preamble "Sure! Here\'s a tighter version:"', out: "Sure! Here's a tighter version:\n\nThe mayor outlined a three-year plan to phase in development incentives.", kind: 'block', expectOk: false },
  { name: 'preamble "Here is the revised paragraph:"', out: 'Here is the revised paragraph:\nThe mayor outlined a plan.', kind: 'block', expectOk: false },
  { name: 'trailer "Let me know if…"', out: 'The mayor outlined a plan.\n\nLet me know if you want it shorter!', kind: 'block', expectOk: false },
  { name: 'code fence wrapping (stripped, then ok)', out: '```\nThe mayor outlined a plan.\n```', kind: 'block', expectOk: true },
  { name: 'wildly long output', out: 'x'.repeat(2000), kind: 'block', expectOk: false },
  { name: 'inline gets a heading', out: '## Plan\nThe mayor outlined a plan.', kind: 'inline', expectOk: false },
  { name: 'inline gets a list', out: '- one\n- two', kind: 'inline', expectOk: false },
  { name: 'inline gets a paragraph break', out: 'The mayor outlined a plan.\n\nIt was good.', kind: 'inline', expectOk: false },
  { name: 'clean inline', out: 'The mayor outlined a three-year plan to phase in development incentives.', kind: 'inline', expectOk: true },
  { name: 'clean block with emphasis and math', out: 'The mayor outlined a **three-year** plan where $x^2$ matters.', kind: 'block', expectOk: true },
  { name: 'empty', out: '   ', kind: 'inline', expectOk: false },
  { name: 'echoes sentinels', out: `⟦SEL⟧${sel}⟦/SEL⟧ and more and more text here to make it long enough to trip the length check for sentinel echo`, kind: 'block', expectOk: false },
]
let fails = 0
for (const c of cases) {
  const r = validate(c.out, { selection: sel, kind: c.kind, instruction: 'shorten' })
  const ok = r.ok === c.expectOk
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} → ${r.ok ? 'accepted' : 'rejected: ' + r.reason}`)
}
console.log(stripFences('```md\nhello\n```') === 'hello' ? 'PASS  stripFences' : 'FAIL  stripFences')
console.log(fails ? `${fails} FAILURES` : 'ALL PASS')
process.exit(fails ? 1 : 0)
