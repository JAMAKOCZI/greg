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

## Quality foundation (v0.2.1)

- `npm test` — `node:test` suites under `test/`
- `scripts/mock-grok-agent.mjs` — fake `grok agent stdio` for offline smoke
- `lib/tabs.mjs` — in-memory tab registry (list / title / touch)
- `lib/text.mjs` — pure helpers (e.g. `titleFromPrompt`)

Step-by-step product plan: [superpowers/plans/2026-07-16-codex-quality-roadmap.md](superpowers/plans/2026-07-16-codex-quality-roadmap.md).

## Roadmap (product)

- [x] Rich tool / diff / plan cards (live ACP stream; `public/cards.js`)
- [x] Multi-tab live sessions (in-process; concurrent `grok agent stdio`)
- [x] Quality foundation (tests + mock agent + tab registry)
- [ ] Cancel / interrupt in-flight turn
- [ ] Durable transcripts under `~/.greg/sessions` (Greg-owned)
- [ ] Multi-tab session history from `~/.grok/sessions` (optional import later)
- [x] Manual vs auto-approve permission cards (wired end-to-end)
- [ ] Project sidebar + workspace switcher (path field only for now)
- [ ] Optional Tauri shell later (desktop packaging of this same UI)
