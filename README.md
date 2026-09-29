# Pali

*Pali* is short for palimpsest: a page written on, scraped, and written on again.

A local, subscription-powered AI writing workspace: chat on the left, a live rich-text document on the right. AI edits land in the document, not in the chat. Changes the assistant makes stay highlighted in muted yellow until your next message, and clicking a ✎ record in the chat jumps to that spot in the document. Highlight text in the document and tick **Include Highlighted** next to Send to make the chat message about that span. Reference files (.docx, .pdf, .xlsx, .csv, .rtf, .pptx, text) can be attached to a document, and documents import from and export to Word.

See `GOAL.md` for the original design spec and `PROGRESS.md` for phase-by-phase build notes.

## How it works

Pali has no API key and makes no LLM HTTP calls. It drives your locally installed, logged-in [Claude Code](https://claude.com/claude-code) CLI through `@anthropic-ai/claude-agent-sdk`, so usage counts against your Claude subscription. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from the child environment. If the boot-time probe ever sees an API key in use, the UI shows a persistent red banner.

Everything stays on your machine. The backend listens only on `127.0.0.1`, and your documents live in a workspace folder you choose on first run.

## Requirements

- Node.js 24
- Claude Code (native install), logged in with your Claude subscription (`claude` then `/login`). Pali looks for it at `%USERPROFILE%\.local\bin\claude.exe` (`~/.local/bin/claude` on macOS/Linux). Set `CANVAS_CLAUDE_PATH` if yours is elsewhere.
- Windows for the one-click launcher. The dev server (`npm run dev`) is plain Node and should work elsewhere, but Pali has only been tested on Windows.

## Install

```
git clone <this repo>
cd <repo>
cd server && npm install && cd ..
cd web && npm install && cd ..
```

## Run

```
npm run dev          # starts backend (127.0.0.1:5199) and frontend (127.0.0.1:5173)
```

Then open http://127.0.0.1:5173. On first run, pick a workspace folder where your documents will be stored. Avoid a OneDrive-synced folder: autosave causes upload churn and conflict copies.

## Launcher (Windows, pin to taskbar)

Run `scripts\make-shortcut.ps1` once to create `Pali.lnk` (in the project folder and on your Desktop) and `Stop Pali.lnk`. `Pali.lnk` runs `scripts\launch.ps1` hidden: it builds the UI if needed, starts the backend once (serving the built UI on 127.0.0.1:5199), and opens Pali in an Edge (or Chrome) app window. Right-click the shortcut → **Pin to taskbar**. Re-run `make-shortcut.ps1` if you move the folder. `Stop Pali.lnk` (or `scripts\stop.ps1`) shuts the backend and its Claude child processes down.

## Where your data lives

- Documents: the workspace folder you chose. One folder per document (`meta.json`, `document.json`, `document.md`, `chat.jsonl`, `session.json`, `files/`, `history/`), a shared `instructions/` library, and `.trash/`.
- App config: `%APPDATA%\Pali\config.json`
- Launcher logs and browser profile: `%LOCALAPPDATA%\Pali\`

None of these are inside the project folder.

## Layout

```
server/   Fastify backend (TypeScript, tsx)
  src/provider/claude/   SDK adapter: warm process pool (surgical lane), persistent chat processes
  src/surgical.ts        strict-output validation + one retry for selection edits
  src/doctools.ts        chat-lane document tools (read_document, replace_block, …)
  src/ingest.ts          reference-file extraction (.docx/.pdf/.xlsx/.csv/.rtf/.pptx/text)
  src/wordio.ts          Word import (mammoth) and export (docx)
  src/workspace.ts       folders-are-the-database storage, instruction library, trash
  src/spike/             auth spike, resume spike, validator tests, API checks
web/      Vite + React + TipTap frontend
  src/surgical/          position-tracking plugin, selection capture, splice/revert, edit queue
  src/chatEdits.ts       applies chat-lane doc_edit frames with tracking + revert
scripts/  dev runner, Windows launcher / stop / shortcut scripts, icon
```

## Useful checks

```
cd server && npm run spike                      # auth spike (apiKeySource=none, rate_limit_event, --bare fails)
cd server && npx tsx src/spike/validate-test.ts # surgical validator unit tests
cd server && npx tsx src/spike/resume-test.ts   # session resume behaviour
npm run typecheck
```

Environment knobs: `CANVAS_PORT` (default 5199), `CANVAS_CLAUDE_PATH`, `CANVAS_RESUME=0` to disable chat-session resume.

Never use `--bare` or `CLAUDE_CODE_SIMPLE`: they disable OAuth and silently defeat subscription auth.

## License

MIT. See [LICENSE](LICENSE).
