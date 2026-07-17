# Greg architecture

## Goal

Codex-style **local web workspace** for Grok Build. Greg is the UI shell; Grok Build is the agent harness.

## Visual direction

- **Layout / density:** inspired by Codex desk (rail, empty state, composer)
- **Color / brand:** [grok.com](https://grok.com) dark UI — near-black neutrals + **orange** accent (`#FF6A00`), not purple. Purple on grok.com is limited to special modes (e.g. incognito).

## Data flow

```
┌──────────────┐   HTTP + SSE    ┌──────────────┐  JSON-RPC / stdio  ┌─────────────────┐
│   Browser    │ ──────────────► │ Greg server  │ ─────────────────► │ grok agent stdio│
│  (public/)   │ ◄────────────── │ (server.mjs) │ ◄───────────────── │  (Grok Build)   │
└──────────────┘   events/cards  └──────────────┘   session/update   └─────────────────┘
```

`GROK_BIN` relative paths are resolved against **Greg’s process cwd** (`resolveGrokBin`), not the session workspace — so `GROK_BIN=./scripts/mock-grok-agent.mjs` works for any project path.

1. User opens a one-time bootstrap URL (`?token=…`). Greg sets an HttpOnly session cookie and redirects to `/`.
2. UI creates a tab via `POST /api/session/new` → Greg spawns `grok agent stdio`, sends ACP `initialize` + `session/new`.
3. UI opens `GET /api/stream?tabId=…` (SSE) for live `session/update` and permission requests.
4. Prompts go through `POST /api/prompt` → ACP `session/prompt`.
5. Permission cards are answered with `POST /api/permission` → JSON-RPC response on the agent stdin.
6. Cancel in-flight turn: `POST /api/cancel` → ACP **notification** `session/cancel` (session stays open).

## Trust model

- Listen address is **127.0.0.1 only**.
- Bootstrap token is single-use; subsequent access requires the session cookie.
- Filesystem and shell tools run inside Grok Build’s own permission / sandbox rules.
- Greg does not re-upload repos; it only relays what the local `grok` process already does.

## Non-goals (v0.1)

- Multi-user / remote exposure without Tailscale or similar
- Replacing Grok Build’s agent loop
- Vendor telemetry of our own
- Shipping maintainer-only tooling (e.g. graphify) as part of the product or install path

## Quality foundation (v0.2.1+)

- `npm test` — `node:test` suites under `test/`
- `scripts/mock-grok-agent.mjs` — fake `grok agent stdio` for offline smoke
- `lib/tabs.mjs` — in-memory tab registry (list / title / touch)
- `lib/text.mjs` — pure helpers (e.g. `titleFromPrompt`)

Step-by-step product plan: [superpowers/plans/2026-07-16-codex-quality-roadmap.md](superpowers/plans/2026-07-16-codex-quality-roadmap.md).

## Workspace file browse (v0.8)

Read-only file tree + text preview (no editor; writes still go through agent tools).

- `lib/fs-browse.mjs`: `resolveUnderRoot`, `listTree`, `readWorkspaceFile`, `fsBrowseHttpStatus`
- Root expands `~` / `~/…` like `resolveWorkspace`
- Containment: lexical + `realpath`; outside-root symlink entries omitted from listings
- File open: re-`realpath` + prefer `O_NOFOLLOW` (TOCTOU shrink); still localhost-only threat model
- Ignores heavy dirs: `node_modules`, `.git`, `dist`, `build`, `.next`, caches, `graphify-out`, etc.
- Tree: depth clamped to **3** (`MAX_TREE_DEPTH`); UI uses **depth 0** + lazy expand per folder
- File: text only, size cap 512 KiB (truncated flag); binary → `415` / `BINARY`
- HTTP: shared status map — `OUTSIDE_ROOT`/`EACCES` → 403, `NOT_FOUND`/`ROOT_NOT_FOUND` → 404, `BINARY` → 415
- API: `GET /api/fs/tree|file`, `GET /api/fs/dirs?path=`, `GET /api/fs/roots`, `POST /api/fs/mkdir`
- Folder picker: clickable **breadcrumbs**, **+ New folder**, **drive** select (system drive default: `/` or `C:`; plus mounts / other letters — no Home / empty placeholder)
- UI: topbar **Files**; sidebar workspace opens the folder modal; selecting a folder opens Files panel
- UI: refreshes when switching sessions / history / new session; expand retries on error

## ACP card fixtures (v0.7)

Anonymized wire samples live in `test/fixtures/acp/` (read/edit/bash/plan/`diff_review`/unified patch).  
`public/cards.js` parses full `session/update` notifications: `file_path`+`old_string`/`new_string`, `content[]` type `diff`, unified patches in `rawOutput`, status aliases.  
Capture notes: `scripts/capture-acp-fixtures.md` (no secrets).

## Settings (v0.6+)

- File: `~/.greg/settings.json` (`GREG_SETTINGS_PATH` override)
- Fields: `alwaysApprove`, `model` (default `grok-4.5`), `effort` (`low`|`medium`|`high`, default `high`), `defaultCwd`, `theme`
- UI: **select** for model (`Grok 4.5 (default)`) and effort (`Low` / `Medium` / `High (default)`)
- Model list: `GET /api/models` / `/api/meta.models` from `~/.grok/models_cache.json`, fallback `grok-4.5`
- Spawn always: `grok agent -m <model> --reasoning-effort <effort> [--always-approve] stdio`
- `session/new`: body `model` / `effort` / `alwaysApprove` override settings; empty → product defaults
- `defaultCwd` on PUT is validated via `resolveWorkspace`
- Effective default workspace: settings.defaultCwd → `GREG_CWD` → process cwd

As of mid‑2026, live Grok Build for a typical SuperGrok account exposes **`grok-4.5`** (default) with effort **high / medium / low**. Composer is a Cursor model line — not currently listed by `grok models` on this CLI.

## Workspace recents (v0.5)

- `lib/workspace.mjs`: `resolveWorkspace` (empty / missing / not-a-dir / `~`+`~/` only / realpath / `R_OK|X_OK`)
- `RecentsStore` → `~/.greg/recents.json` (max 20, MRU, write mutex, UUID temps)
- `GET /api/recents` is read-only (missing dirs filtered in response; no rewrite)
- `POST /api/session/new` rejects invalid cwd with `400` + `code`
- Successful session adds cwd to recents; `POST/DELETE /api/recents` (DELETE empty path → 400)
- UI: click recent → fill path + New session (guard against double-create)

## Durable transcripts (v0.4)

Greg-owned history (not `~/.grok/sessions`):

- Default root: `~/.greg/sessions/<id>.json` (override with `GREG_SESSIONS_DIR`)
- Created on `POST /api/session/new` with `id = tabId`
- Messages appended on user prompts; agent/thought text flushed at turn end; tools upserted by id; plans replaced in place
- API: `GET /api/history`, `GET /api/history/:id`, `DELETE /api/history/:id` (409 if session still live)
- UI: **Tasks / Earlier** — open a saved chat **auto-resumes** the agent (`session/new` with same `tabId` + `resume: true`, same transcript file). Composer enabled. Read-only only if resume fails.
- Integrity: per-id write locks, 0o700 dir / 0o600 files, fsync before rename, await flush on SIGINT/SIGTERM

### Resume + model context

ACP `session/new` always starts a **blank** agent memory. Greg does **not** call Grok `session/load` (that expects upstream `~/.grok` session ids, not Greg transcripts).

On `resume: true` (or restart of an existing live tab), Greg:

1. Loads `~/.greg/sessions/<tabId>.json`
2. Builds a compact text seed via `lib/resume-context.mjs` (user/agent + short tool/plan lines; skips system/thought/permission; char/message caps; prefers recent turns)
3. Holds the seed on the tab (`entry.contextSeed`) until the **first** `POST /api/prompt`
4. Prepends the seed to that prompt with `applyContextSeed` so the model sees prior turns
5. Persists only the real user message (seed is never written into the transcript)

Response fields on `session/new`: `contextSeeded`, `contextSeed: { messageCount, charCount, truncated }`.

Atomic writes: temp file + rename via `lib/transcript-store.mjs`.

## Session human rules (tool discipline)

Every `session/new` injects `_meta.rules` from `lib/greg-session-rules.mjs` (Grok folds this into `<human_rules>` on fresh sessions). Goals:

- Prefer `read_file` / list; on Windows read failures, one simple shell read — no forensics spiral
- Do not auto-load check-work / review skills for small “check this file” tasks
- Minimize tool noise (Greg shows every card)

Disable with env `GREG_NO_SESSION_RULES=1`.

## Quiet tool failures (UI)

- stderr lines matching `tool_error` / `tool_output_error` / deserialize IO noise are filtered (`lib/agent-stderr.mjs`)
- Failed tool cards show a one-line summary; full error + tool id are collapsed (`public/cards.js`)

## Message rendering (markdown)

Agent and user bubbles use client-side GFM-ish markdown (`public/markdown.js`):

- Headings, lists, bold/italic, links, blockquotes
- Fenced code blocks with language label, **Copy**, and lightweight token highlighting
- GFM tables
- No raw HTML passthrough (escaped)
- Streaming: throttled re-render (~48ms); final pass when the turn ends or a tool card starts

Thought / system / tool bubbles stay plain text.

## Agent stderr in the UI

`grok agent stdio` writes diagnostics to **stderr**. Greg forwards chunks over SSE (`stderr` event) as system bubbles.

Known **non-fatal** patterns are filtered server-side (`lib/agent-stderr.mjs`) so they do not look like session failure:

- `worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)` — HTTP MCP OAuth worker (rmcp) died without usable credentials; the agent turn continues, that MCP is simply unavailable
- `failed to decode … Method not found` — ACP method the agent does not implement
- `Skipping OAuth MCP in non-interactive mode…`

Real errors still surface. Fix root cause for MCP auth: authenticate the MCP in Grok TUI, set `Authorization` headers, or disable the server in `~/.grok/config.toml` (`enabled = false` / remove `[mcp_servers.*]`).

## Import Grok Build sessions (Phase 7)

Optional bridge so CLI/TUI history is usable inside Greg:

| Path | Role |
|------|------|
| `~/.grok/sessions/<url-encoded-cwd>/<uuid>/summary.json` | Index metadata (title, cwd, timestamps) |
| `…/chat_history.jsonl` | Conversation lines (`user` / `assistant` / `reasoning` / `tool_result` / …) |

- **Read-only** — Greg never writes under `~/.grok` (override scan root with `GREG_GROK_SESSIONS_DIR`)
- Format is **upstream-unstable** (`chat_format_version: 1` observed); parse defensively
- `GET /api/import/grok` — list recent Grok sessions (+ `imported` flag if already in Greg)
- `POST /api/import/grok` `{ id, force? }` — convert → `~/.greg/sessions/<id>.json` with `source: { kind: "grok", … }`
- Mapping: skip system prompts + synthetic user reminders; `assistant` → agent (+ tool stubs); `reasoning` → thought (capped); `tool_result` → tool (capped)
- UI: **Import Grok** in the Tasks sidebar → modal list → Import / Open (then same resume path as Greg history)
- Re-import without `force` → `409 ALREADY_IMPORTED`

## Cancel (v0.3)

Wire shape matches Grok Build / ACP (see `xai-org/grok-build` leader stdio tests):

```json
{ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": "…", "reason": "user" } }
```

- This is a **notification** (no JSON-RPC response id).
- Greg: `AcpBridge.cancel()` → `POST /api/cancel` → UI **Cancel** / `Ctrl+.`.
- Expected agent behavior: end the in-flight `session/prompt` with `stopReason: "cancelled"`; keep the session process alive.
- API returns `hadPending` (whether a prompt was in flight on the bridge when cancel was sent).
- UI tracks **per-tab** `sending` so multi-session cancel/composer stay correct.
- Mock agent: cooperative cancel via microtask yields between chunks (`MOCK_STREAM_MS` only paces UX demos; not required for cancel). Sticky cancel applies only when a prompt is queued/in-flight, not pure idle.
- If a real agent ignores cancel, the prompt request stays pending (bridge timeout 30m); use **Stop session** to force-kill. Cancel can be re-sent while still busy.

## Roadmap (product)

- [x] Rich tool / diff / plan cards (live ACP stream; `public/cards.js`)
- [x] Multi-tab live sessions (in-process; concurrent `grok agent stdio`)
- [x] Quality foundation (tests + mock agent + tab registry)
- [x] Cancel / interrupt in-flight turn
- [x] Durable transcripts under `~/.greg/sessions` (Greg-owned)
- [x] Optional import of `~/.grok/sessions` into Greg history (Phase 7; read-only)
- [x] Manual vs auto-approve permission cards (wired end-to-end)
- [x] Project sidebar + workspace recents (validated path + MRU)
- [x] ACP tool/diff/plan card hardening (fixtures under `test/fixtures/acp/`)
- [x] File-centric UX (read-only tree + preview under workspace root)
- [ ] Optional Tauri shell later (desktop packaging of this same UI)
