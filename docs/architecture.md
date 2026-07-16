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

## Durable transcripts (v0.4)

Greg-owned history (not `~/.grok/sessions`):

- Default root: `~/.greg/sessions/<id>.json` (override with `GREG_SESSIONS_DIR`)
- Created on `POST /api/session/new` with `id = tabId`
- Messages appended on user prompts; agent text flushed at turn end; tools/plans/permissions best-effort
- API: `GET /api/history`, `GET /api/history/:id`, `DELETE /api/history/:id`
- UI: sidebar **History** — read-only replay (composer disabled)

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
- [ ] Project sidebar + workspace switcher (path field only for now)
- [ ] Optional Tauri shell later (desktop packaging of this same UI)
