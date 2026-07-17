# Greg architecture

## Goal

Codex-style **local web workspace** for Grok Build. Greg is the UI shell; Grok Build is the agent harness.

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
- API: `GET /api/fs/tree?root=&path=&depth=`, `GET /api/fs/file?root=&path=`
- UI: topbar **Files**; refreshes when switching sessions / history / new session; expand retries on error

## ACP card fixtures (v0.7)

Anonymized wire samples live in `test/fixtures/acp/` (read/edit/bash/plan/`diff_review`/unified patch).  
`public/cards.js` parses full `session/update` notifications: `file_path`+`old_string`/`new_string`, `content[]` type `diff`, unified patches in `rawOutput`, status aliases.  
Capture notes: `scripts/capture-acp-fixtures.md` (no secrets).

## Settings (v0.6+)

- File: `~/.greg/settings.json` (`GREG_SETTINGS_PATH` override)
- Fields: `alwaysApprove`, `model`, `effort` (`low`|`medium`|`high`|null), `defaultCwd`, `theme`
- UI: **select** for model and effort (not free text)
- Model list: `GET /api/models` / `/api/meta.models` from `~/.grok/models_cache.json` (official CLI cache), fallback known catalog (`grok-4.5` as of 2026-07)
- Spawn: `grok agent [-m MODEL] [--reasoning-effort EFFORT] [--always-approve] stdio`
- `session/new`: body `model` / `effort` / `alwaysApprove` override settings when present (null = no override)
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
- UI: sidebar **History** — read-only replay (composer disabled); delete requires confirm
- Integrity: per-id write locks, 0o700 dir / 0o600 files, fsync before rename, await flush on SIGINT/SIGTERM

Atomic writes: temp file + rename via `lib/transcript-store.mjs`.

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
- [ ] Multi-tab session history from `~/.grok/sessions` (optional import later)
- [x] Manual vs auto-approve permission cards (wired end-to-end)
- [x] Project sidebar + workspace recents (validated path + MRU)
- [x] ACP tool/diff/plan card hardening (fixtures under `test/fixtures/acp/`)
- [x] File-centric UX (read-only tree + preview under workspace root)
- [ ] Optional Tauri shell later (desktop packaging of this same UI)
