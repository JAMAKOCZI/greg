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

## Settings (v0.6)

- File: `~/.greg/settings.json` (`GREG_SETTINGS_PATH` override)
- Fields: `alwaysApprove`, `model`, `defaultCwd`, `theme`
- `GET/PUT /api/settings`; also embedded in `/api/meta`
- `session/new`: if body has `model` / `alwaysApprove` keys, those win (null model = no override); if omitted, settings apply. UI always sends explicit values.
- `defaultCwd` on PUT is validated via `resolveWorkspace` (expanded/realpath when valid)
- Effective default workspace: settings.defaultCwd → `GREG_CWD` → process cwd

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
- [ ] Optional Tauri shell later (desktop packaging of this same UI)
