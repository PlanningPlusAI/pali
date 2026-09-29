# Canvas — build progress and phase evidence

## Phase 0 — Auth spike (DONE, 2026-09-07)

Script: `server/src/spike/phase0.ts` (`npm run spike` in `server/`). SDK `@anthropic-ai/claude-agent-sdk@0.3.263` pinned exact; CLI `~/.local/bin/claude.exe` v2.1.263 (SDK manifest expects 2.1.263 — matched).

**Positive** — SDK one-shot, `settingSources: []`, `tools: []`, `persistSession: false`, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` deleted from child env:

```
init: apiKeySource = none | model = claude-sonnet-5 | tools = []
rate_limit_event: {"status":"allowed","rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.14},"seven_day":{"utilization":0.01}}}
result: success | wall 2601 ms | TTFT 2554 ms | total_cost_usd 0.001593 (list-price accounting, not a charge)
text: "OK"
```

**Negative** — raw CLI `claude -p --bare`:

```
assistant text: "Not logged in · Please run /login"
result: is_error=true, exit code 1
```

Note: this SDK version does **not** bundle a CLI binary; it resolves the native install (or `pathToClaudeCodeExecutable`). The app passes the path explicitly and checks the CLI version against `manifest.json` at boot.

## Phase 1 — Skeleton and the pool (DONE, 2026-09-07)

Backend `server/` (Fastify on 127.0.0.1:5199, SSE over POST) + `web/` (Vite+React, proxies `/api`). `npm run dev` at the root starts both. Tests: `node server/src/spike/phase1-tests.mjs <timing|roundtrip|chat|nowrite|disconnect|shutdown>` against a running backend.

- **Streams token-by-token in the UI** — headless Edge (Playwright) watched the assistant bubble grow: `1989ms→6 chars, 2154→19, 2470→65`; final "Red/Blue/Green/Yellow/Purple", meta "1865ms to first token · 2404ms total". Screenshot taken.
- **No orphaned children** — `claude.exe` counts (1 = this Claude Code session itself): after `endChat` on 3 chats 6→3 (=me + 2 pool); after graceful shutdown (`POST /api/shutdown` → provider.shutdown) 4→1; after hard `taskkill /F /T` of the server 3→1 (children exit when their stdin pipe breaks). Client disconnect mid-stream interrupts the turn (`busy:false` afterwards) but keeps the chat process alive by design (chat lane persists; 15-min idle kill).
- **TTFT cold vs pool** (one-shot "reply OK", Sonnet): warm pool 661ms / 834ms (a third hit a still-booting refill: 1679ms); cold spawn 2087ms / 1983ms. Chat lane: first turn (cold) 1634ms, second turn on the warm process 624ms. Pre-boot measured directly: init frame arrives 33ms after the message is sent to a pre-booted process, first token ~1s later.
- **Round-trip intact** — one-shot echo of a payload with `"quotes"`, `'quotes'`, newlines, `&`, `%PATH%`, `%USERPROFILE%`, backticks, `$dollar ${braces}`, `C:\Windows\System32\...`, `\d+\s*\w+`, a lone `\`, `café — naïve 日本語 🚀`: `roundtrip identical: true`. (A `\b` sequence in an earlier payload was dropped by the *model*, not transport — `\backslash` → `ackslash`; `\d`, `\s`, `\W` survive.)
- **Chat lane cannot write** — init frame `tools: ["Read"]`, zero tool calls when asked to create hello.txt; reply: "I'm not able to create or write files — the only tool I have available is Read". Scratch cwd stayed empty. Adapter sets `tools:['Read']`, `disallowedTools:[Bash, PowerShell, Write, Edit, ...]`, `permissionMode:'dontAsk'`, `settingSources:[]`, `strictMcpConfig:true`.
- Boot-time auth probe: `apiKeySource=none` → UI banner logic present (shows "⚠ Using API credits, not your subscription." if not). CLI 2.1.263 == SDK manifest 2.1.263.

## Phase 2 — Editor, library, instruction sets (DONE, 2026-09-07)

Workspace configured at `D:\Canvas-Workspace` via the first-run picker API (`POST /api/config`); OneDrive path offered only as an explicit opt-in with the churn warning. Layout: `config.json`, `instructions/`, `.trash/`, one folder per document (`meta.json`, `document.json`, `document.md`, `chat.jsonl`, `files/{original,extracted,index.json}`, `history/`). Tests: `web` Playwright script (scratchpad `pw/ui2.mjs`) and `node server/src/spike/phase2-tests.mjs`.

- **Formatted doc + equation survives refresh** — headless Edge typed an H1, bold, inline math via toolbar, a bullet list with italic, and a block equation; waited for "Saved"; reloaded. After reload: `katex renders: 2`, `h1 present: true`, `bold: true`, `italic: true`, `list: true`. `document.md` on disk:

  ```
  # Quadratic formula

  The roots are **important** and given by $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$ for all a.

  - first point
  - second point with *emphasis*

  $$
  \int_0^1 x^2\,dx = \frac{1}{3}
  $$
  ```
  (Bug found and fixed on the way: the toolbar reused one TipTap command chain across buttons, so each click replayed earlier commands.)
- **Three documents keep their own transcripts** — alpha/beta/gamma each told a secret word; each `chat.jsonl` holds only its own (2 entries each). Beta asked "what secret words have I told you" → `"saxophone"` only; the logged prompts for beta contain neither `pineapple` nor `lighthouse`.
- **Hand-copied folder appears after rescan**: `true`. **Rename keeps folder path**: folder `gamma-doc` still exists, title "Gamma renamed". **Delete moves to `.trash/`**: `movedTo: D:\Canvas-Workspace\.trash\hand-copied-folder` (first attempt hit a transient Windows rename lock right after the copy; trashDoc now retries EPERM/EBUSY briefly).
- **Instruction sets** — created via the app → `instructions/british-no-oxford.md` exists; a `pirate-voice.md` dropped into the folder by hand shows in the picker list; attaching both → `meta.json` `instructions: ["british-no-oxford","pirate-voice"]`; the chat got a system note "Instruction sets changed … A new chat session starts with the next message"; the next reply was `"Arr, the sea be a deep blue-green, matey!"`; the logged system prompt contains "Standing instructions from the user" with British before Pirate (attached order = prompt order).
- One writer per document: in-memory open markers with 45s expiry and 15s heartbeat; second tab gets a read-only banner. Session resume is gated behind `CANVAS_RESUME=1` until Phase 6 verifies it.

## Phase 3 — Surgical edits (DONE, 2026-09-07)

Implementation: `web/src/surgical/{plugin,capture,splice,useSurgical}.ts`, `web/src/ActionBar.tsx`; backend `server/src/surgical.ts` (validation + one retry) and `POST /api/docs/:slug/edit`. Positions are ProseMirror positions tracked through every transaction's mapping by a plugin (start bias +1, end bias −1); the span's plain text is compared at apply time and the edit is refused if the span itself changed. Selection = whole top-level block → block-level (top-level blocks replaced); otherwise inline (only the inline range replaced). Context = the markdown of the doc with ⟦SEL⟧ sentinels, cut to the containing blocks ±500 chars. Streaming preview is shown in the pending badge; the document only receives validated output. One edit in flight per document; the rest queue and re-capture against the updated text when their turn comes.

Evidence (headless Edge through the real UI, `scratchpad/pw/ui4.mjs` + `ui5.mjs`; validator unit test `server/src/spike/validate-test.ts`):

- **Only ¶3 changes** — "Shorten" on ¶3 of 5: `¶3 changed: true | ¶1,2,4,5 byte-identical in document.json: true`; 246 → 153 chars; toast "Revised ¶3" after 1903ms; chat shows only `✎ revised ¶3 (Make this more concise…)`, no prose.
- **Typing in ¶1 while ¶4 is in flight** — typed "BREAKING NEWS — ", Enter, and a new paragraph at the top while the request ran (`typing finished while edit still in flight: true`). Result: 7 blocks, ¶1 split as typed, `¶2 identical: true | ¶3 identical: true | ¶4 changed (target): true | ¶5 identical: true`, and ¶4 is still the parks paragraph, rephrased.
- **Inline edit between bold and math** — rephrased the middle sentence of "Energy is **conserved** … $E = mc^2$ …": `bold "conserved" intact: true | inline math intact: true | sentence changed: true`; other blocks identical.
- **"Sure! Here's a tighter version:" never reaches the document** — validator unit tests: 12/12 pass (preambles, trailers, fences stripped, implausible length, block constructs in inline, paragraph breaks, sentinel echo). Live: one Expand run was rejected and retried (`ok in 6606ms (2 attempts)` in the server log, record marked "retried once"); when coaxed to add the preamble, the model obeyed the strict contract instead, and the document never contained "Sure!".
- **Revert** — from the toast: `restored ¶3 exactly: true`; from the chat action record: `true`; Ctrl+Z: `true` (the splice is one transaction).
- **Overlapping edits fired quickly** — Shorten ¶3 then Rephrase ¶3–¶4 before the first finished: pending badge showed 2; both applied in order, `doc schema-valid: true`, blocks outside ¶3–¶4 identical; the second edit was re-captured against the already-shortened text.
- **Instruction set** — with "British English, no Oxford comma" attached: `"We organised the data, analysed the colour patterns and summarised the results."` (British, no Oxford comma; prompt contained the standing block). Same sentence with the per-request toggle off: `"We organized the data, analyzed the color patterns, and summarized the results."` (prompt had no standing block).
- `history/` gets one snapshot per AI edit (10 after the run). Bugs fixed on the way: paragraph label off by one for block boundaries; action bar not reappearing for an identical re-selection; a stale toast timer wiping a newer toast.

## Phase 4 — Chat-driven editing (DONE, 2026-09-07)

Implementation: `server/src/doctools.ts` (six in-process tools via the SDK's `createSdkMcpServer`/`tool()`: `read_document`, `replace_block`, `replace_range`, `insert_after`, `insert_at_end`, `delete_range`), chat route sends the document as `[b1]…[bn]` blocks every turn; `web/src/chatEdits.ts` tracks each block's ProseMirror range through the plugin, applies each `doc_edit` frame as one transaction with a `history/` snapshot and an action record with Revert. Chat lane runs with `allowedTools: ['Read','mcp__canvas']`, everything else disallowed, `dontAsk`. Evidence (`scratchpad/pw/ui6.mjs`, headless Edge):

- **Question → prose, document untouched** — "Are sections 1 and 3 redundant?" → `"Yes — Section 3 ("Summary of the study") just restates Section 1's Introduction…"`; `doc untouched: true`.
- **"Remove section 3"** → one `delete_range` (heading + paragraph): blocks 8 → 6, `other blocks intact: true`; chat shows the assistant's one line "Removed Section 3." plus the record `✎ removed section "3. Summary of the study" (+1 more block) · revert`; no document text in the reply. **Revert** from the record: `restored the document exactly: true`. (First run: the model also renumbered the next heading; the tool guide now says "make exactly the change asked for", and the rerun did only the delete.)
- **"Add a short section about future work at the end"** → `insert_at_end`, 2 blocks appended (heading + paragraph), prefix unchanged; reply "Added a "Future Work" section at the end of the document." shares 0 of 12 long words with the inserted text.
- **Freshness after a hand edit** — inserted a "HAND EDIT: zebra umbrella quantum…" paragraph by hand; "Quote the first five words of the first block" → `"HAND EDIT: zebra umbrella"`; "Delete the paragraph that starts with HAND EDIT" → removed exactly that block, rest identical. Every turn's logged prompt carries the current document (3/3).

## Phase 5 — Ingestion (DONE, 2026-09-07)

Implementation: `server/src/ingest.ts` (pure-JS extractors: `mammoth` for .docx, `pdf-parse` v2 for .pdf text layer, `xlsx` for .xlsx/.csv → markdown tables, an RTF control-word stripper, `jszip` (mammoth's dependency) for .pptx slide text, plain text for text/code). Originals in `files/original/`, sidecars in `files/extracted/<name>.md`, `files/index.json` with type/size/chars/pages/status/warning/summary; toggles in `meta.json`. Files > 15k chars get a one-shot outline (Haiku) cached at ingest and are referenced by path; the file list is always inlined; a 60k-char inline budget degrades to outlines with a UI notice. Upload via multipart (`@fastify/multipart`), drop onto the document pane or "+ Add files". Evidence (`scratchpad/pw/ui7.mjs`, headless Edge; fixtures generated by `fixtures.mjs`):

- **.docx** dropped and asked about → `"The report states turnaround improved 37% (from 52 hours to 33 hours), and recommends extending the pilot to the Mombasa hub in Q3."`; the logged prompt carries the extracted docx text under "## Reference files".
- **Text-layer PDF summarized into a new section** → `insert_at_end` added a heading + paragraph about the "leafhopper" solar quadcopters; `grep -rniE "embedding|vector store|pinecone|chroma|faiss|cosine"` over `server/src` and `web/src` finds nothing.
- **Scanned PDF warning at drop time** → chip tooltip and files-bar line: "scan.pdf: Little text found; likely scanned. Visual reading will be used." (32 chars over 2 pages).
- **Large vs small** → `inlined: [report.docx, paper.pdf, scan.pdf, small.txt] | summarized: [big.txt]`; the 40k-char big.txt appears in the prompt only as an outline plus its `files/extracted/big.txt.md` path (whole prompt 3,053 chars), while small.txt's full text (PLATYPUS-7) is inlined. The outline happened to capture the appendix codeword, which is the outline doing its job.
- **Toggle off** → next prompt no longer contains PLATYPUS-7 (docx text still present); a surgical edit's prompt mentions no file at all (files are opt-in per request).
- **Isolation** → document B: "No files are attached to this document, and there's no earlier discussion…"; B's logged prompt contains only B's own text (the only regex hit was the phrase "the document as blocks" in the tool guide). Separate chat processes per document (`phase-5-doc-a:p8, phase-5-doc-b:p13`).

## Phase 6 — Session continuity and polish (DONE, 2026-09-07)

**Resume verification first** (`server/src/spike/resume-test.ts`, reduced options, `ANTHROPIC_*` stripped): a session told "MARMALADE-19", killed, then resumed —
- identical options → `"MARMALADE-19"`, same session id, no error;
- different system prompt → remembered *and* the new prompt applied ("MARMALADE-19 PINEAPPLE");
- different model (haiku) → remembered, `model: claude-haiku-4-5-20251001`;
- MCP server + allowedTools added → remembered, `tools: ["Read","mcp__canvas__ping"]`, tool call worked.

Finding: resume tolerates differing options on this CLI. Decision: resume is now on by default (`CANVAS_RESUME=0` disables), `session.json` records `{sessionId, model, systemHash}` and resume is only attempted when they match; an instruction-set change still starts a fresh session as GOAL §9 requires.

Evidence in the app (`scratchpad/pw/ui8.mjs`, headless Edge):
- **Resume across a backend restart** — told the chat "TANGERINE-88", killed the backend (all child processes died), started it again, asked for the password → `"TANGERINE-88"`, `session id unchanged: true`, `options recorded identical: true`.
- **Instruction change → fresh session, UI says so** — attaching a set shows "Instruction sets changed (british-no-oxford). A new chat session starts with the next message; the transcript above is kept." Next question about the password → `"unknown"`; new session id and system hash in `session.json`.
- **"now do the same to the next paragraph"** — after a selection edit on ¶1 ("Rewrite this paragraph in the past tense."), typing that sentence in chat is intercepted in the frontend: ¶2 rewritten in the past tense, ¶3 unchanged, exactly one **surgical** prompt was sent carrying the explicit instruction, no chat-lane prompt; chat shows only `✎ revised ¶2 (Rewrite this paragraph in the past tense…)`. (Bug found: a Python patch had turned `\b` into a backspace byte in the regex; fixed.)
- **Copy as rich text** — toolbar "⧉ Copy" writes `text/html` + `text/plain` to the clipboard (verified via `navigator.clipboard.read()`); "⧉ MD" copies markdown.
- Model picker per lane (chat header / document header), rate-limit status from `rate_limit_event` in the chat header ("5h 62% · 7d 6%").
- **Phase 3 criteria still pass** — see the regression run recorded below.

### Phase 3 regression after Phase 6 (2026-09-07)

`ui4.mjs` rerun with resume enabled and all Phase 4–6 code in place: A (only ¶3 changes; ¶1,2,4,5 byte-identical) ✓ · B (typing in ¶1 while ¶4 in flight; 7 blocks, target rephrased, others identical — this run the edit finished before the typing did, the earlier runs covered the in-flight case) ✓ · C (bold + inline math intact around an inline rephrase) ✓ · E (revert from toast, from chat record, Ctrl+Z all exact) ✓ · F (overlapping edits serialized, doc schema-valid) ✓ · G (British set on; toggle off drops the standing block from the prompt) ✓. 11 history snapshots.

## Status

All six phases of GOAL.md are built and verified. Not started: §12 stretch goals (.docx export, Gemini/Codex adapters, history browser).

## Change: selection tools replaced by "Include Highlighted" (2026-09-07, user request)

The floating selection action bar (Shorten/Expand/…) got in the way of normal highlighting and was removed. Instead the chat box has an **Include Highlighted** checkbox next to Clear/Send: when checked, the current document selection (kept visibly highlighted even while typing in chat) is appended to the message with its block id, and the model answers about it or edits that block with the document tools. Verified (`scratchpad/pw/ui9.mjs`, built UI served by the backend): mouse drag → no bar; checkbox → highlight persists after focusing chat; "Make this much shorter." → `replace_block` on ¶1 only, chat shows the message plus "▸ highlighted (¶1): …" and the ✎ record with revert; the prompt carried the highlighted span as `[b1]`. The surgical lane code (`web/src/surgical`, `server/src/surgical.ts`, `/api/docs/:slug/edit`) remains but is no longer wired to the UI.

## Change: Pali rename, "changed since last message" highlight, click-to-jump (2026-09-07, user request)

- App renamed **Pali** (short for palimpsest): window/tab title, empty state, system prompt, launcher, shortcuts (`Pali.lnk`, `Stop Pali.lnk`, old Canvas shortcuts removed), icon `scripts/pali.ico`, config at `%APPDATA%\Pali\config.json` (migrated automatically from the Canvas folder), logs/profile under `%LOCALAPPDATA%\Pali`. The project folder stays `Canvas` on disk so existing paths keep working; the configured workspace stays `D:\Canvas-Workspace` (new installs default to `D:\Pali-Workspace`).
- Every chat-driven change stays highlighted in muted yellow (`.ai-changed`) until the next message is sent; a brighter flash still marks it for 4s.
- ✎ records in the chat are clickable: the document scrolls to the change and selects it (tracked range this session, or found by the recorded text snippet after a reload).
- Verified (`scratchpad/pw/ui10.mjs`): title "Pali"; muted highlight still present 4.5s after the edit; click on the record scrolled a 30-paragraph doc to ¶25 with the change selected; next message cleared the highlight; after reload the record still jumps.
