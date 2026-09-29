import { readFileSync } from 'node:fs'
import { extract } from '../ingest.js'
// Usage: npx tsx src/spike/extract-test.ts <fixtures-folder>
const dir = (process.argv[2] ?? 'fixtures').replace(/[\\/]?$/, '/')
for (const f of ['report.docx', 'paper.pdf', 'scan.pdf', 'big.txt', 'small.txt', 'sales.xlsx']) {
  try {
    const r = await extract(f, readFileSync(dir + f))
    console.log(`${f}: type=${r.type} chars=${r.text.length}${r.pages ? ` pages=${r.pages}` : ''}${r.warning ? ` WARNING: ${r.warning}` : ''}\n   ${JSON.stringify(r.text.slice(0, 150))}`)
  } catch (e: any) { console.log(`${f}: ERROR ${e.message}`) }
}
