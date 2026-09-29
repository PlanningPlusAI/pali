# GOAL: Canvas — a local, subscription-powered AI writing workspace

## 1. What we are building

A local web app that replicates the useful core of Gemini's Canvas: a **side-by-side workspace** with a chat pane on the left and a live rich-text document on the right.

The defining behavior: **AI edits land in the document, not in the chat.** The chat pane is a place to talk *about* the document — ask questions, get answers, discuss — and a command surface for changing it. When the model changes the document, the change appears in the document and the chat shows only a one-line action record ("✎ removed section 3 · [revert]"). The user should never have to copy prose out of a chat bubble.

Runs entirely on the user's machine. Single user, no accounts, no cloud services, no database server.

### The five capabilities that define success

1. **Surgical text edits** — select a sentence or paragraph, give an instruction, and *only that span* changes. No whole-document regeneration.
2. **Rich text formatting** — a real toolbar: headings, bold/italic, bullet and numbered lists, plus LaTeX math rendered inline.
3. **Document ingestion** — drop reference files into a document's workspace; the AI can read them as context. Strictly per-document (§6, §8).
4. **Reusable instruction sets** — the user writes named instruction files (a writing style, a role, a house rule) once, then attaches any combination of them to a document. They act as foundational system-level prompts (§9).
5. **Subscription auth, zero API credits** — see §2. This is a hard constraint, not a preference.

### Non-goals (do not build these)

- No API-key-based LLM client. Ever. See §2.
- No embeddings, vector store, RAG pipeline, or chunking. The agent has a file-reading tool already.
- No multi-user, no auth, no sharing, no deployment.
- No `.docx`/`.rtf` export in the core phases. Copy-paste out of the browser preserves rich formatting via the HTML clipboard flavor. `.docx` export is a stretch goal (§12).
- No Electron, no VS Code extension. A localhost web app is cheaper and better here.
- No Gemini/Codex adapters in v1 (§3). Model choice in v1 means choosing among Claude models.

---

## 2. The architecture-defining constraint: subscription auth

**The backend must never call an LLM HTTP API.** Instead it drives the vendor's own CLI as a child process and reads its structured output stream. The CLI is already logged in to the user's subscription, so usage draws on the subscription's rate-limit budget rather than metered API credits.

### Verified on this machine — treat as established fact

Spawning `claude -p` from Node with `--output-format stream-json --verbose` returned:

- `"apiKeySource": "none"` on the init frame — no API key involved.
- `rate_limit_event` frames carrying `five_hour` and `seven_day` utilization — subscription metering, the desired outcome.
- A `session_id` usable with `--resume <id>`.
- Clean newline-delimited JSON.

The installed CLI is a native executable at `%USERPROFILE%\.local\bin\claude.exe` (v2.1.263), so `spawn(..., { shell: false })` works directly. Node is v24.

**Caveat:** the result frame includes `total_cost_usd`. This is list-price accounting, *not* a charge against credits. Do not "fix" it. Do not let it cause a redesign.

### Use the Claude Agent SDK, not a hand-rolled spawn

Use `@anthropic-ai/claude-agent-sdk` (TypeScript). It is Anthropic's supported way to drive the CLI programmatically: it spawns its own bundled copy of the CLI, handles stdin delivery, frame parsing, abort, `resume`, `model`, tool restriction, and in-process custom tools. Pin its exact version in `package.json` — this also pins the CLI it bundles, which matters (see "Known risks" below).

Everything in "Spawn hygiene" below still applies; the SDK just exposes the knobs as options rather than argv.

### ⚠ `--bare` is a trap — never use it

The CLI's `--bare` flag ("skip hooks, LSP, plugins, …") looks like the obvious fix for boot latency. **It also disables OAuth.** Verified: `claude -p --bare` on this machine returns "Not logged in · Please run /login". Any use of `--bare` (or `CLAUDE_CODE_SIMPLE=1`) silently defeats the entire project. Grep for it in code review.

### The reduced option set that keeps subscription auth

Verified working:

| Purpose | CLI flag | SDK option |
|---|---|---|
| Skip user/project hooks, plugins, settings-defined MCP | `--setting-sources ""` | `settingSources: []` |
| Skip all other MCP servers | `--strict-mcp-config` | implied by `settingSources: []` with no `mcpServers` |
| No built-in tools at all (surgical lane) | `--tools ""` | `tools: []` |
| Don't write session files (one-shots) | `--no-session-persistence` | — |
| Model selection | `--model sonnet` etc. | `model` |

`~/.claude.json` and managed settings are read regardless; that is fine.

### Latency: measured numbers, and the design they force

Measured on a trivial "reply OK" prompt with Sonnet, API-key env vars stripped:

| Spawn mode | Wall time | Time to first token |
|---|---|---|
| Plain `claude -p` (all hooks/MCP loaded) | ~5.0s | ~2.8s |
| Reduced option set, cold spawn | 2.2–3.4s | 1.0–2.1s |
| Warm process (`--input-format stream-json`), turn 2+ | ~1.5s | ~1.4s |

Roughly 1.2s is CLI process boot that no flag removes; the remaining ~1.4s is the model round trip itself. **A sub-second edit is not achievable. Design for a ~1.5s floor and a 2.5s typical.**

Two consequences:

1. **Hide the boot cost with a pre-spawned pool.** Verified: a `claude -p --input-format stream-json --output-format stream-json` process boots (~0.8s), emits its `init` frame, then waits for user messages on stdin and accepts multiple turns. So: keep N (start with 2) idle pre-booted processes for the surgical lane. A surgical edit takes one from the pool, sends exactly one turn, reads the result, and **kills the process** (fresh context every time — see §7's two lanes). The pool refills in the background. Chat-lane processes are pre-booted the same way but kept alive for the conversation.
2. **The UI must own the wait.** Mark the selected span as "working" the instant the request is sent, stream the replacement in as it arrives, and never block typing elsewhere.

Measure in Phase 1; do not discover it in Phase 3.

### Headless permissions — do this or the chat lane can bypass the document gate

In `-p` mode nothing can answer a permission prompt. Set permissions explicitly per lane:

- **Surgical lane:** no built-in tools at all (`tools: []`).
- **Chat lane:** `allowedTools: ["Read"]` plus `permissionMode: "dontAsk"`, and explicitly disallow `Bash`, `Write`, `Edit`, `WebFetch`, `WebSearch`. The chat lane changes the document **only** through the app's own custom tools (§7), never by writing `document.md` on disk. If the agent could edit files directly, every safety rule in §7 would be bypassed.
- Set `cwd` to the document's folder and no `additionalDirectories`, so `Read` cannot reach other documents (§6, isolation).

### Spawn hygiene (non-negotiable)

- **Prompts go in over stdin, never as command-line arguments**, and spawn with `shell: false`. Document text contains quotes, newlines, `%VAR%`, backticks, and `&`. Windows argv quoting will mangle some of it and the corruption looks exactly like a model failure. The SDK does this correctly; a hand-rolled spawn must too.
- **Strip `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child env.** If either is ever set in the user's shell the CLI silently prefers it and starts billing credits. They are unset on this machine today; that is not something to rely on. Explicitly `delete` them from the env object passed to the child.
- **Assert auth on startup.** On backend boot, run a cheap probe and confirm `apiKeySource === "none"`. If not, log it and show a **persistent, loud banner in the UI** — "⚠ Using API credits, not your subscription." Do not hard-abort; loud and visible, not fatal.
- Kill child processes when their request is cancelled or the client disconnects. Kill the whole pool on backend shutdown.

### Known risks (accepted by the user — do not design around, but do not hide)

- **Terms and deprecation.** Anthropic's Agent SDK docs state that third-party developers may not *offer* claude.ai login or rate limits in their products. A personal, local tool driving the user's own logged-in CLI is not clearly covered, and the user accepts the risk. The same docs say bare mode "will become the default for `-p` in a future release." **So: pin the SDK/CLI version, and if a future upgrade breaks subscription auth, report it rather than working around it.** The provider interface (§3) is the escape hatch if this path ever closes.
- **Shared budget.** Usage draws on the same subscription rate-limit windows as the user's normal coding sessions. Acceptable. Surface the `rate_limit_event` numbers in the UI (Phase 6).

---

## 3. Provider strategy

**v1 implements Claude only**, behind a provider interface so others can drop in later.

```ts
interface Provider {
  id: string
  listModels(): Promise<{ id: string; label: string }[]>
  probeAuth(): Promise<{ ok: boolean; usingApiKey: boolean; detail: string }>
  // stateless, no tools, strict output — surgical lane
  oneShot(req: { system: string; prompt: string; model: string; signal: AbortSignal }): AsyncIterable<Frame>
  // persistent, tools available, resumable — chat lane
  chat(req: {
    system: string; prompt: string; model: string; cwd: string
    sessionId?: string; tools: CustomTool[]; signal: AbortSignal
  }): AsyncIterable<Frame>
}
```

Normalized frames: `{ type: 'text' | 'tool_call' | 'done' | 'error' | 'rate_limit', ... }`. All Claude-specific logic (SDK options, frame mapping, pool management) lives in the Claude adapter.

Claude models available via `model`: aliases `fable`, `opus`, `sonnet`, `haiku` and full IDs. Default the surgical lane to `sonnet` (fast, cheap against the rate-limit window) and the chat lane to the user's chosen model; both user-selectable per document.

`gemini` and `codex` CLIs are installed on this machine but as `.cmd` shims under `%APPDATA%\npm`, which Node cannot spawn with `shell: false`. Future adapters must resolve the underlying JS entry point and spawn `node` directly. **Do not implement them in v1.**

---

## 4. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vite + React + TypeScript | Fast, boring, well-trodden |
| Editor | **TipTap** (ProseMirror) | §5 — its position model is load-bearing |
| Markdown bridge | `tiptap-markdown` (or `prosemirror-markdown`) | §7 — the model reads and writes markdown |
| Math | TipTap math extension + KaTeX | Inline `$…$` and block `$$…$$` |
| Backend | Node + Fastify (or Express), TypeScript | Hosts the SDK; must be a real server |
| LLM driver | `@anthropic-ai/claude-agent-sdk`, pinned | §2 |
| Transport | SSE (server → client streaming) | Simpler than WebSockets for one-directional streams |
| Storage | Plain files on disk | §6 |

Bind to `127.0.0.1` only.

---

## 5. Why TipTap: the stale-position problem

A surgical edit is: record where the selection is → send it to the model → wait ~2s → splice the reply back in at the recorded position. **If the user types anywhere above that selection while the request is in flight, a raw character offset now points at the wrong text and the splice silently corrupts the document.**

ProseMirror solves this with *position mapping*. **Requirement:** at request time record the selection as ProseMirror positions, and while the request is in flight append every transaction's `mapping` to an accumulated `Mapping`; map the recorded positions through it before splicing. Do not store raw string indices. Fallback only if remapping proves impossible: lock the selected region against editing for the duration. Remapping is preferred and is the reason this editor was chosen.

This must be explicitly tested (§10, Phase 3).

---

## 6. Storage model, document library, and isolation

### The workspace root

All documents live under a single configurable workspace folder, chosen on first run and stored in app config. **Default: `D:\Canvas-Workspace`.**

**Do not default to `~/Documents`.** On this machine it is redirected into OneDrive; debounced autosave into a synced folder produces upload churn and conflict copies. Offer a OneDrive path as an explicit opt-in with that tradeoff stated.

### Layout

```
<workspace>/
  config.json               # workspace settings (default models, etc.)
  instructions/             # GLOBAL instruction library — §9
    concise-style.md
    editor-role.md
  <document-slug>/
    meta.json               # title, created, updated, model choices, tags,
                            #   attached instruction names, per-file toggles
    document.json           # TipTap JSON — canonical, lossless
    document.md             # markdown mirror, rewritten on every save
    chat.jsonl              # this document's chat transcript + action log
    session.json            # chat lane's session id + the options it was created with
    files/                  # uploaded reference docs — §8
      original/
      extracted/
      index.json
    history/                # timestamped snapshots (one per AI edit + periodic)
  .trash/                   # deleted documents moved here, never unlinked
```

**Why both `.json` and `.md`:** the `.json` is the editor's lossless state. The `.md` is what the model reads and writes — the model is never shown, and never asked to produce, TipTap JSON. The markdown mirror is the agent-facing interface, and it happens to be git-friendly and readable in VS Code.

Autosave on a debounce. Never lose work on refresh.

### Folders are the database

No index database. Scan the workspace on startup and on window focus. Drop a folder in and it appears; delete one and it's gone.

- The folder slug is immutable once created; renaming changes `title` in `meta.json` only.
- Slugs derive from the initial title, deduplicated with a numeric suffix.
- Deleting moves the folder to `.trash/`.

### Isolation between documents is a hard rule

**Nothing from document A may ever reach a request made from document B.** The user considers cross-contamination a critical failure. Concretely:

- Every prompt is assembled from exactly: the global instruction sets *attached to this document*, this document's text, this document's `files/extracted/`, and this document's chat history. Nothing else.
- Each document has its own chat session id. Sessions are never shared, forked, or reused across documents.
- The chat lane's process runs with `cwd` = the document folder and no additional directories, so its `Read` tool cannot open sibling folders.
- Surgical-lane pool processes are single-use and killed after one turn, so nothing persists between calls.
- Write a test: after a distinctive conversation and upload in document A, ask document B "what did we discuss?" and assert no leakage in both the reply and the logged prompt.

### Chat is per-document

Each document owns its own transcript and session. Switching documents switches the entire conversation. `session.json` records the session id **and the SDK options it was created with** (model, settingSources, tools) so resume uses identical options — whether `resume` tolerates differing options is unverified; don't find out by accident. Verify in Phase 6.

### The sidebar library

A collapsible left sidebar listing documents by last-modified: title, one-line excerpt, relative timestamp. New / rename / duplicate / delete / reveal in Explorer. Search by substring over titles and `document.md`. No search index.

### One writer per document

Two tabs on the same document will fight over autosave. Hold "open" markers **in backend memory only** (they vanish on restart by construction); a second tab gets a warning banner and read-only mode. Never persist a lock without an expiry.

---

## 7. The edit contract

This is the heart of the product. Implement it deliberately.

### Surgical edits (selection-driven)

1. User selects text. A floating action bar appears with an instruction input plus quick actions (Shorten / Expand / Rephrase / Fix tone / Make a list).
2. Frontend captures: the selected text as markdown, a **window of surrounding context** (the containing block plus ±500 chars, with the selection delimited by sentinel markers), a remappable position anchor (§5), and whether the selection is **inline** (within one paragraph) or **block-level** (whole paragraphs).
3. Backend assembles the prompt: system prompt = strict-output contract + attached instruction sets (§9); user message = context window + instruction. **Reference files are excluded by default** (§8).
4. **Strict output contract** in the system prompt: return only the replacement text; no preamble, no explanation, no code fences, no restating the document, no commentary; preserve the markdown conventions of the surrounding text; if the selection is inline, return inline markdown only (no headings, no lists).
5. Backend **validates the response** before it touches the document: strip stray code fences; reject preamble patterns ("Sure", "Here's", "Here is", trailing "Let me know…"); reject outputs wildly longer than plausible; reject block-level constructs in an inline replacement. On failure, retry once with a corrective instruction, then surface an error. Never splice unvalidated output.
6. **Apply immediately** (user decision — not preview-then-accept): remap the anchor, parse the markdown as inline or block nodes to match the selection kind, splice as a single transaction, save, write a `history/` snapshot. The new text is highlighted for a few seconds, and a toast plus the chat action record both offer **one-click Revert**. Revert restores the exact prior nodes at the (remapped) position. Ctrl+Z also works, since the splice is one transaction.
7. The chat pane logs an action record — `✎ revised ¶3 · [revert]` — never the prose.

### Markdown ↔ editor splicing is where formatting gets lost — be careful

- Inline selection inside a paragraph with mixed marks (bold, italic, inline math): the reply is parsed as inline markdown and replaces only the selected inline range; marks outside the selection are untouched.
- Block selection: parsed as blocks and replaces whole nodes.
- LaTeX round-trips as `$…$` / `$$…$$` in both directions.
- Explicit acceptance tests for both cases (§10, Phase 3).

### Concurrent surgical edits

**Serialize surgical edits per document: one in flight at a time, the rest queued** and shown as pending in the UI. Overlapping spans are then applied against already-updated text.

### Two session lanes — decide now, not in Phase 6

- **Chat lane → persistent session** with `resume`. Conversational prose is expected here. Changes to the document happen only via custom tools (below).
- **Surgical lane → one-shot, stateless.** Fresh single-use pool process each time. No conversational memory: prior instructions and chatty replies in context make the model drift back to "Here's a tighter version!" Follow-ups like *"now do the same to the next paragraph"* are resolved **in the frontend** (it knows the last edited span and instruction) and sent as a fresh, fully explicit one-shot.

### Chat-driven document editing — the mechanism

The chat lane can answer questions in prose ("Are sections 1 and 3 redundant?" → "Yes, because…") and can change the document when asked ("Remove section 3"). It needs an unambiguous way to express an edit, so **give it in-process custom tools** (SDK `createSdkMcpServer` / `tool()`; no external process):

- `read_document()` → current markdown with stable block ids (e.g. `¶12`, `H2#3`) so the model can address regions precisely.
- `replace_block(id, markdown)`, `replace_range(from_id, to_id, markdown)`, `insert_after(id, markdown)`, `insert_at_end(markdown)`, `delete_range(from_id, to_id)`.

The backend receives each tool call, validates it (ids exist, markdown parses), applies it to the document as a single transaction with a `history/` snapshot, returns success to the model, and logs an action record with Revert in the chat. Prose the model writes *around* tool calls is shown in the chat as normal. System prompt instruction: "Never paste document text into your reply; make changes with the tools. Reply in prose only to discuss or answer."

**Document freshness:** because the session resumes, earlier turns hold stale copies of the document. Each chat turn re-sends the current document (or the model is instructed to call `read_document` first). The session is conversation memory only, never the source of truth for text.

---

## 8. Document ingestion — how reference files reach the model

Reference files belong to exactly one document (§6, isolation). There is no shared library of files.

### The three tiers

| Tier | Formats | Path |
|---|---|---|
| 1. Native text | `.md` `.txt` `.csv` `.json`, source code | Read directly |
| 2. PDF | `.pdf` | Dual path — extracted text *and* native visual read |
| 3. Office / binary | `.docx` `.xlsx` `.pptx` `.rtf` | **Must be converted at ingest.** The agent's read tool cannot open these |

### Convert at ingest, not at read time

On drop, the backend runs an extractor and writes a plain-text sidecar to `files/extracted/<name>.md`; `files/index.json` records type, size, char count, status, warnings. Failures surface in the UI at drop time.

### Extractors — pure-JS npm packages only

No pandoc, LibreOffice, or tesseract on this machine; do not add install prerequisites.

| Format | Library |
|---|---|
| `.docx` | `mammoth` |
| `.pdf` | `pdfjs-dist` (or `pdf-parse`) for the text layer; `pdftotext` optional fallback, never required |
| `.xlsx` / `.csv` | `xlsx` (SheetJS) → markdown table |
| `.rtf` | control-word stripper |
| `.pptx` | slide text extraction; low priority |

### PDFs get both paths

Extracted text is the default. The original stays in `original/` and the chat-lane model is told it may `Read` it directly (visual) when extracted text looks insufficient. Native PDF reads are page-range limited (~20 pages per request), so extraction is the primary path. **Scanned-PDF detection:** very few chars per page → UI warning "Little text found; likely scanned. Visual reading will be used." No OCR locally.

### Size threshold, decided at ingest

- **Small (< ~15k chars):** inline the full text into the prompt.
- **Large:** give the path plus an outline/summary generated once at ingest (by a one-shot call) and cached in `index.json`.
- **Always inline the file list** (names, types, sizes, one-line descriptions).

Reference material must never crowd out the document itself; if the inline budget is exceeded, drop to summaries and say so in the UI.

### Scope control

- Files appear as removable chips, each toggleable on/off; toggles persist in `meta.json`.
- **Chat lane:** enabled files included by default.
- **Surgical lane:** excluded by default, opt-in per request via a checkbox on the action bar. Dumping 15k chars into "make this shorter" wastes context and increases drift off the strict contract.

---

## 9. Instruction sets — reusable foundational prompts

The user wants to write instructions once (a writing style, a role/responsibility, house rules) and attach any combination of them to a document.

### Storage

`<workspace>/instructions/<name>.md`. One file per instruction set; the first line may be a `# Title`, the rest is the instruction text. Plain markdown, editable in the app **and** in any editor — the folder is the source of truth, rescanned like documents.

### Attaching

- A document's `meta.json` holds an ordered list of attached instruction names.
- UI: an "Instructions" control in the chat pane header showing attached sets as chips; a picker lists the library with create / edit / duplicate / delete. Editing a set in the library affects every document that attaches it — say so in the UI.
- Multiple sets can be attached; order is the order they appear in the prompt.

### Precedence — "foundational, then refined by the user"

Attached sets are concatenated into the **system prompt** of every request for that document, under a heading such as "Standing instructions from the user", *after* the app's own contract text and *before* the current task. State the layering to the model explicitly: "The user's message for this turn takes precedence over standing instructions where they conflict; otherwise standing instructions always apply."

- **Chat lane:** always included. Since the session resumes, changing the attached set must **start a new session** (the system prompt is fixed at session creation) — tell the user this happens and keep the old transcript in `chat.jsonl`.
- **Surgical lane:** included by default (a style guide is exactly what "rephrase this" should honor), with a per-request toggle to run without them.

### Isolation note

The instruction library is the *only* thing shared across documents, by design. Instruction files must never contain or accumulate document content; the app never writes to them except when the user edits them in the library UI.

---

## 10. Phases and acceptance criteria

Build in this order. Each phase ends with something demonstrable. Report each phase's evidence before moving on.

### Phase 0 — Auth spike (re-verify, don't assume)

Using the pinned SDK from Node, with API-key env vars stripped: stream a one-shot; log `apiKeySource: "none"` and a `rate_limit_event`. Also confirm the negative: the same call with `--bare` (or the SDK equivalent) fails auth, proving the guard matters.

- **Accept when:** both results are shown. If subscription auth does not hold, **stop and report** — everything downstream depends on it.

### Phase 1 — Skeleton and the pool

Vite+React app, Node backend, SSE streaming, chat pane that talks to the SDK. Pre-spawned process pool with the reduced option set.

- **Accept when:** typing in the chat pane streams a visible response token-by-token, and killing the tab does not orphan a child process (check Task Manager).
- **Accept when:** time-to-first-token is measured for cold spawn vs pool; the pool path lands near the ~1.5s floor from §2, and the numbers are reported.
- **Accept when:** a prompt containing quotes, newlines, `&`, `%PATH%`, backticks, and non-ASCII round-trips intact.
- **Accept when:** the chat lane cannot write files: ask it to create a file in its cwd and show the tool is unavailable or denied.

### Phase 2 — Editor, library, and instruction sets

TipTap with toolbar (H1/H2/H3, bold, italic, bullet, numbered, blockquote, code), inline + block LaTeX, autosave to `document.json` + `document.md`. Full §6 workspace: first-run picker, sidebar, new/rename/duplicate/delete/trash. §9 instruction library UI and attachment.

- **Accept when:** a formatted document with a rendered equation survives refresh, and `document.md` on disk is clean markdown with `$…$` math.
- **Accept when:** three documents each retain their own chat transcript; a folder copied in by hand appears after rescan; rename keeps the folder path; delete moves to `.trash/`.
- **Accept when:** an instruction set created in the UI appears as a file in `instructions/`, a file dropped into that folder appears in the picker, and attaching two sets to a document is reflected in `meta.json`.

### Phase 3 — Surgical edits *(the core deliverable)*

Full §7 surgical contract: action bar, context window, validation, immediate apply, highlight, revert, queueing.

- **Accept when:** selecting one of five paragraphs and asking "make this more concise" changes only that paragraph; the other four are byte-identical in `document.json`.
- **Accept when:** typing in ¶1 *while* a revision of ¶4 is in flight still splices correctly into ¶4. **Test this explicitly.**
- **Accept when:** selecting a sentence in the middle of a paragraph that contains bold text and an inline equation, and rephrasing it, leaves the bold and the equation outside the selection intact.
- **Accept when:** a response beginning "Sure! Here's a tighter version:" is caught by validation and never reaches the document.
- **Accept when:** Revert from the toast and from the chat action record both restore the exact prior text; Ctrl+Z also works.
- **Accept when:** two edits fired quickly against overlapping spans are serialized and do not corrupt each other.
- **Accept when:** an attached "write in British English, no Oxford comma" instruction set visibly changes surgical output, and the per-request toggle switches it off.

### Phase 4 — Chat-driven editing

Custom document tools (§7), action records with Revert, prose answers allowed.

- **Accept when:** "Are sections 1 and 3 redundant?" gets a prose answer in chat and the document is untouched; "Remove section 3" then removes exactly that section via a tool call, the chat shows only a one-line action record with Revert, and Revert restores it.
- **Accept when:** "add a section about X at the end" appends via `insert_at_end`, and no document text appears in the chat reply.
- **Accept when:** after the user hand-edits the document, the next chat instruction acts on the *current* text, not a stale copy.

### Phase 5 — Ingestion

§8 in full.

- **Accept when:** dropping a `.docx` and asking about its contents works — this proves the extraction pipeline exists.
- **Accept when:** a text-layer PDF can be summarized into a new section, with no embedding code anywhere.
- **Accept when:** a scanned PDF surfaces a visible warning at drop time.
- **Accept when:** a >15k-char file is summarized and referenced by path while a small file is inlined — verifiable in the logged prompt.
- **Accept when:** toggling a chip off removes the file from the next request; a surgical edit does not include files by default.
- **Accept when (isolation):** after a distinctive conversation and file upload in document A, document B's chat shows no knowledge of them, and the logged prompt for B contains nothing from A.

### Phase 6 — Session continuity and polish

`resume` for the chat lane only. Model picker per lane. Rate-limit status from `rate_limit_event` in the UI. Copy-as-rich-text button.

- **Do this first:** verify a chat session created with the reduced options resumes cleanly with identical options recorded in `session.json`. If it doesn't, document the finding and decide.
- **Accept when:** changing attached instruction sets starts a fresh session with the new system prompt, and the UI says so.
- **Accept when:** "now do the same to the next paragraph" works with the referent resolved in the frontend.
- **Accept when:** Phase 3's criteria still pass unchanged.

---

## 11. Working agreement

- **Phase 0 first, and report before continuing.** If subscription auth through the SDK does not hold, the design is void.
- **Never use `--bare` / `CLAUDE_CODE_SIMPLE`.** Never pass prompts as argv. Never let the chat lane write files.
- Prefer boring, legible code. Personal tool, not a platform.
- Don't add a database, job queue, auth layer, or cloud dependency. If a phase seems to need one, raise it.
- When acceptance criteria are met, say so plainly and show the evidence (logged prompts, before/after JSON, timings).

---

## 12. Stretch goals (only after Phase 6)

- `.docx` export via the `docx` npm package from TipTap JSON.
- Gemini and/or Codex adapters (§3; note the `.cmd` shim caveat).
- Version history browser over `history/`.
