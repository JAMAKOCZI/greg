# Greg → Codex-quality Roadmap (step-by-step)

> **For agentic workers:** Execute **one phase at a time**. Do not start Phase N+1 until Phase N exit criteria pass. Prefer subagent-driven-development for multi-task phases; always re-verify after merge. Checkbox tracking: `- [ ]` / `- [x]`.

**Goal:** Grow Greg from a working v0.2 ACP desk into a daily-driver Codex-style local workspace **without** reimplementing Grok Build’s agent loop, while keeping each change reviewable, tested, and reversible.

**Architecture:** Greg remains a thin shell: Browser → HTTP/SSE → `grok agent stdio` (ACP). New product depth (history, workspace UX, cancel, settings) lives in Greg; tools, models, sandbox, and the agent loop stay in the official binary.

**Tech Stack:** Node.js ≥ 20, ESM, zero runtime npm dependencies (stdlib only). Vanilla `public/*` UI. Optional later: Tauri packaging (not in this plan).

---

## Global Constraints

- **Thin shell only** — no agent loop reimplementation; no vendoring xAI sources into the product
- **Localhost only** — bind `127.0.0.1`; never default to `0.0.0.0`
- **Zero runtime deps** unless a phase explicitly revisits this constraint and the user approves
- **No secrets** in repo (`~/.grok/auth.json`, tokens, API keys)
- **Graphify is not product** — gitignored maintainer tooling only
- **Commits:** Conventional Commits, English; one logical change per commit
- **Chat language:** Polish with user; code/docs/commits English
- **ACP shapes are unstable** — parse defensively; prefer adapters + fixtures over brittle assumptions
- **Quality over speed** — smaller PRs/phases beat large mixed dumps

---

## Working agreement (how we keep quality high)

### Cadence

1. **Pick exactly one open task** from the current phase (or the smallest vertical slice that still delivers value).
2. **Write or update a failing test first** when the change is pure logic (parsers, stores, title helpers, path utils). For pure UI chrome, use a short manual script + `npm run check`.
3. **Implement the minimum** that makes the test pass.
4. **Verify** with the phase’s gate commands (below).
5. **Commit** (user says `commit` or `/commit` if not auto-requested).
6. **Stop and report** — show what changed, how to test, risks. Wait before the next task unless the user said “continue the phase”.
7. **Never parallelize three features into the same files again without a merge plan** (last time: cards.js almost lost to multi-session). Prefer sequential tasks on shared UI files; parallelize only isolated modules (`lib/*` pure logic).

### Definition of Done (every task)

- [ ] Behavior matches the task’s acceptance criteria
- [ ] `npm run check` passes (and phase-specific tests)
- [ ] No accidental dependency adds
- [ ] Docs touched if user-visible behavior changed (`README.md` and/or `docs/architecture.md`)
- [ ] No graphify / secrets staged
- [ ] Commit message describes *why* if non-obvious

### Definition of Done (every phase)

- [ ] All tasks in the phase checked off or explicitly deferred with reason
- [ ] Phase exit criteria (below) all green
- [ ] Smoke: `npm start` → bootstrap URL → New session (or mock mode) does not throw
- [ ] Version bump only at phase boundaries (or user-requested release), not every micro-task
- [ ] Short “phase recap” written into this plan under **Progress log**

### Review gates

| Gate | When | Who |
|------|------|-----|
| Self-check | End of each task | Implementer runs tests |
| Spec alignment | End of each phase | Diff against this plan |
| Optional `/check-work` or `/review` | After risky phases (ACP, persistence) | User or verification subagent |

### What we deliberately do *not* do mid-phase

- Redesign the whole UI “while we’re here”
- Add npm frameworks (React, Vite, Express) without a dedicated decision phase
- Touch desktop/Tauri until web desk is daily-driver quality
- Load full monorepo of grok-build into greg

---

## Current baseline (v0.2.0) — do not re-build

Already shipped and treated as given:

- Local HTTP + one-time bootstrap token + session cookie
- ACP bridge (`lib/acp-bridge.mjs`) + multi-tab map in `server.mjs`
- SSE stream, prompt, permission respond
- Multi-session UI (live only; in-memory)
- Permission cards (Allow once / Deny + auto-approve)
- Tool / diff / plan cards (`public/cards.js`)

Known gaps that this plan closes (in order):

1. Quality foundation (tests, mock agent, modularity)
2. Cancel / interrupt turn
3. Durable session transcripts (Greg-owned store)
4. Workspace UX (recents + validation)
5. Settings (model, defaults)
6. Diff / tool card hardening from real ACP fixtures
7. File-centric UX (tree + open file) — later
8. Optional disk bridge to `~/.grok/sessions` — later
9. Desktop shell — out of scope until web is solid

---

## File map (target shape after Phase 0–3)

Keep files focused; split when a file exceeds ~400–500 lines of *logic* (UI may stay larger if cohesive).

| Path | Responsibility |
|------|----------------|
| `server.mjs` | HTTP wiring, listen, open browser — thin |
| `lib/http.mjs` | Auth cookie, static, JSON helpers |
| `lib/acp-bridge.mjs` | One child process, JSON-RPC stdio |
| `lib/tabs.mjs` | Tab map, metadata, list/title (extract from server) |
| `lib/transcript-store.mjs` | Durable transcripts (Phase 2+) |
| `lib/workspace.mjs` | Path validation, recents (Phase 3+) |
| `lib/settings.mjs` | Greg settings file under `~/.greg/` (Phase 4) |
| `public/app.js` | UI orchestration, sessions, SSE |
| `public/cards.js` | Tool/diff/plan rendering |
| `public/permissions.js` | Permission card DOM (optional extract) |
| `public/index.html` / `styles.css` | Shell chrome |
| `test/*.test.mjs` | Node test runner (node:test) |
| `test/fixtures/acp/*.json` | Captured ACP payloads |
| `scripts/mock-grok-agent.mjs` | Fake `grok agent stdio` for tests |

---

## Phase 0 — Quality foundation

**Why first:** Without fixtures and a mock agent, every later feature is “hope it works with real grok”. Quality collapses under that.

**Goal:** Deterministic tests for pure logic + a mock ACP agent so the server can be exercised without network/login.

### Tasks

#### Task 0.1 — Test harness

**Files:**
- Create: `test/smoke.test.mjs` (or `test/title.test.mjs` first pure unit)
- Modify: `package.json` scripts: `"test": "node --test test/**/*.test.mjs"`
- Modify: `package.json` scripts: `"check"` stays; add `"test"` only

- [x] **Step 1:** Add `node:test` + `node:assert/strict` smoke test that imports a pure helper (extract `titleFromPrompt` to `lib/text.mjs` if still private in `server.mjs`)
- [x] **Step 2:** Run `npm test` — expect fail until helper is exported
- [x] **Step 3:** Export helper; tests pass
- [x] **Step 4:** Commit `test: add node:test harness and titleFromPrompt unit`

**Acceptance:** `npm test` and `npm run check` both exit 0 on a clean tree.

#### Task 0.2 — Mock Grok agent (stdio ACP)

**Files:**
- Create: `scripts/mock-grok-agent.mjs`
- Create: `test/fixtures/acp/session-update-agent-chunk.json` (minimal)
- Modify: docs in `AGENTS.md` — how to run with `GROK_BIN=./scripts/mock-grok-agent.mjs`

**Behavior (minimum):**
- Read JSON-RPC lines from stdin
- Answer `initialize` with a stub result
- Answer `session/new` with `{ sessionId: "mock-…" }`
- On `session/prompt`, emit a few `session/update` notifications (agent_message_chunk, tool_call, plan) then respond to the request
- On permission-style client requests: only if we later need them; skip until cancel phase

- [x] Implement mock
- [x] Document env: `GROK_BIN=node` may need a wrapper; prefer executable shebang `#!/usr/bin/env node` + `chmod +x`, or `GROK_BIN` pointing at a small shell wrapper that runs the mock
- [x] Manual: `GROK_BIN=… GREG_NO_OPEN=1 npm start` → New session succeeds without real grok (automated via `test/mock-agent.test.mjs`)
- [x] Commit `test: add mock grok agent for local ACP smoke`

**Acceptance:** New session + one prompt works against mock without `grok login`.

#### Task 0.3 — Extract tab registry (no behavior change)

**Files:**
- Create: `lib/tabs.mjs`
- Modify: `server.mjs` to use it
- Create: `test/tabs.test.mjs`

- [x] Move Map + `tabMeta` + `listTabs` + `titleFromPrompt` usage behind a small API: `createTab`, `getTab`, `deleteTab`, `listTabs`, `touch`, `setTitle`
- [x] Unit tests for list sort by `lastActiveAt` and title auto-set rules
- [x] Commit `refactor: extract tab registry for testability`

**Acceptance:** Same API surface for HTTP; tests cover registry pure logic.

#### Task 0.4 — Phase 0 exit

- [x] `npm test && npm run check`
- [x] Mock smoke documented in README “Development”
- [x] Progress log entry
- [x] Version bump to `0.2.1` foundation release

**Exit criteria:**
- [x] CI-equivalent local: check + test green
- [x] Can demo full chat path with mock agent
- [x] No product UI redesign in this phase

---

## Phase 1 — Cancel / interrupt turn

**Goal:** User can stop an in-flight agent turn without killing the whole tab (Codex “stop generating”).

### Research spike (mandatory, short)

- [x] Inspect official Grok Build / ACP for cancel methods (`session/cancel`, `session/prompt` abort, notification). Check local `~/projects/grok-build` docs or ACP types **read-only**.
- [x] Record the chosen method in `docs/architecture.md` under a “Cancel” subsection.
- [x] If ACP has no cancel: document fallback (kill child and respawn session — worse UX, explicit).

**Decision:** ACP **notification** `session/cancel` with `{ sessionId, reason }`. Pending `session/prompt` resolves with `stopReason: "cancelled"`.

### Tasks

#### Task 1.1 — Bridge API

**Files:**
- Modify: `lib/acp-bridge.mjs`
- Create: `test/acp-bridge-cancel.test.mjs` (may use mock child)

- [x] Add `cancel(sessionId?)` that sends the agreed ACP method (or documented fallback)
- [x] Ensure pending `session/prompt` promise rejects or resolves cleanly with a cancelled status (define one behavior and test it)
- [x] Commit `feat: support ACP session cancel on bridge`

#### Task 1.2 — HTTP + UI

**Files:**
- Modify: `server.mjs` — `POST /api/cancel` `{ tabId }`
- Modify: `public/app.js` / `index.html` — Cancel button enabled only while `status === busy`
- Modify: styles as needed

- [x] Wire endpoint
- [x] Button + keyboard shortcut (Esc already used; prefer `Ctrl+.` or a visible Cancel next to Send)
- [x] Manual test with mock (mock should honor cancel by stopping chunks)
- [x] Commit `feat: cancel in-flight turn from UI`

### Phase 1 exit criteria

- [x] Cancel during mock streaming stops further agent chunks within ~1s
- [x] Session remains usable for a new prompt
- [x] Tests for bridge cancel path green
- [x] Architecture doc updated

---

## Phase 2 — Durable transcripts (Greg-owned)

**Goal:** After restarting Greg, user can reopen a past conversation (read-only replay first; optional reattach later).

**Design choice (locked for this plan):**  
Store under **`~/.greg/sessions/<id>.json`** (Greg-owned). Do **not** depend on parsing `~/.grok/sessions` in v0.3 — that format is upstream and can change. Optional Phase 7 may *import* grok sessions if needed.

### Data model (minimum)

```json
{
  "id": "uuid",
  "cwd": "/path",
  "title": "…",
  "createdAt": 0,
  "updatedAt": 0,
  "messages": [
    { "role": "user"|"agent"|"system"|"tool"|"plan"|"permission", "ts": 0, "text": "…", "meta": {} }
  ]
}
```

### Tasks

#### Task 2.1 — Store module + tests

**Files:**
- Create: `lib/transcript-store.mjs`
- Create: `test/transcript-store.test.mjs` (use `os.tmpdir()` isolation)

- [x] `save`, `load`, `list`, `appendMessage`, `delete`
- [x] Atomic write (write temp + rename)
- [x] Commit `feat: greg-owned transcript store`

#### Task 2.2 — Server hooks

**Files:**
- Modify: `server.mjs` / `lib/tabs.mjs`
- New endpoints:
  - `GET /api/history` → list saved sessions
  - `GET /api/history/:id` → full transcript
  - `DELETE /api/history/:id`
- On prompt / agent chunks: append to in-memory buffer; flush on turn end and on stop
- [x] Commit `feat: persist transcripts on turn boundaries`

#### Task 2.3 — UI history

**Files:**
- Modify: sidebar — section “History” below live sessions
- Opening history: show replay transcript; composer disabled or “Continue in new session” that seeds context (v1: **replay only** is enough for exit)
- [x] Commit `feat: browse and replay saved sessions`

### Phase 2 exit criteria

- [x] Kill Greg, restart, history list shows last chats
- [x] Replay renders user + agent text at minimum (tools best-effort)
- [x] Store tests pass with temp dir
- [x] Disk layout documented in architecture.md

---

## Phase 3 — Workspace UX

**Goal:** Not just a raw path string — validate cwd, recent workspaces, one-click switch.

### Tasks

#### Task 3.1 — Path helpers

**Files:**
- Create: `lib/workspace.mjs`
- Create: `test/workspace.test.mjs`

- [ ] `resolveWorkspace(path)` → absolute path or error
- [ ] Reject empty; optionally reject non-existent dirs (configurable)
- [ ] Recents list in `~/.greg/recents.json` (max 20)
- [ ] Commit `feat: workspace path helpers and recents store`

#### Task 3.2 — API + UI

- [ ] `GET /api/recents`, `POST /api/recents` (or update on session/new)
- [ ] Sidebar: recent chips/list under Workspace
- [ ] Clicking recent fills cwd and can start new session
- [ ] Commit `feat: workspace recents in sidebar`

### Phase 3 exit criteria

- [ ] Invalid path shows clear error on New session
- [ ] After using a project, it appears in recents across restarts

---

## Phase 4 — Settings

**Goal:** Persist Greg defaults (not Grok account auth).

### Settings file `~/.greg/settings.json`

```json
{
  "alwaysApprove": false,
  "model": null,
  "defaultCwd": null,
  "theme": "dark"
}
```

### Tasks

- [ ] `lib/settings.mjs` load/save + tests
- [ ] `GET/PUT /api/settings`
- [ ] UI: small settings panel or sidebar toggles bound to settings
- [ ] Pass `model` into `AcpBridge` on session/new from settings when body omits model
- [ ] Commit `feat: persistent greg settings`

### Phase 4 exit criteria

- [ ] Toggle always-approve, restart Greg, toggle still set
- [ ] Model field (if exposed) passed through to bridge args

---

## Phase 5 — ACP card hardening

**Goal:** Tool/diff/plan cards match real Grok Build payloads, not only mock shapes.

### Tasks

- [ ] Capture fixtures: run real `grok` once, log raw ACP notifications to `test/fixtures/acp/captured/` (script; do not commit secrets)
- [ ] Redact paths if needed; commit anonymized fixtures
- [ ] Unit tests for `extractDiffs` / `normalizeStatus` against fixtures
- [ ] Fix card gaps found in capture
- [ ] Commit `test: real ACP fixtures` + `fix: card parsing for captured shapes`

### Phase 5 exit criteria

- [ ] At least 3 real tool_call shapes covered by tests
- [ ] Diff view correct for a known edit tool fixture

---

## Phase 6 — File-centric UX (Codex desk depth)

**Goal:** Browse project files and open read-only preview (write still via agent tools).

**Scope control:** Read-only tree + file preview only. No full editor.

### Tasks

- [ ] `GET /api/fs/tree?path=` (depth-limited, ignore heavy dirs: `node_modules`, `.git`)
- [ ] `GET /api/fs/file?path=` (size cap, text only)
- [ ] Security: resolve under workspace root only (path traversal tests)
- [ ] UI: collapsible file tree + preview pane or modal
- [ ] Commit(s) `feat: workspace file tree and preview`

### Phase 6 exit criteria

- [ ] Cannot read files outside workspace root
- [ ] Tree usable on greg’s own repo without freezing UI

---

## Phase 7 — Optional: import `~/.grok/sessions`

**Only if** Phase 2 is solid and user still wants upstream history.

- Spike: document format stability
- Read-only importer → convert to Greg transcript format
- Never write back into `~/.grok/` from Greg

---

## Phase 8 — Desktop shell (later)

- Tauri or similar wrapping the same web UI
- Same localhost server or embedded
- **Not started** until Phases 0–4 exit criteria met at minimum

---

## Suggested versioning

| After phase | Version | User-facing meaning |
|-------------|---------|---------------------|
| 0 | 0.2.1 | Foundation / tests |
| 1 | 0.3.0 | Cancel turn |
| 2 | 0.4.0 | Durable history |
| 3–4 | 0.5.0 | Workspace + settings daily driver |
| 5–6 | 0.6.0 | Hardened cards + files |
| 8 | 1.0.0-beta | Desktop optional |

---

## Execution order (strict)

```
Phase 0  →  1  →  2  →  3  →  4  →  5  →  6  →  (7 optional)  →  (8 later)
```

Do **not** skip Phase 0.  
Do **not** start Phase 6 before 2 (history matters more than file tree for Codex feel).  
Phase 5 can swap with 3–4 only if real ACP bugs block daily use — note the swap in Progress log.

---

## Progress log

| Date | Phase | Notes |
|------|-------|-------|
| 2026-07-16 | — | Plan created from v0.2.0 baseline (`72d02dc`) |
| 2026-07-16 | **0 complete** | Test harness, mock agent, `lib/tabs` + `lib/text`; v0.2.1; 14 tests green |
| 2026-07-16 | **0 review fixes** | Code review on Phase 0: unique mock tool ids, safe TabRegistry.create, endSse on open fail, fixture tests, MOCK_STREAM_MS, npm test glob, check covers mock (17 tests) |
| 2026-07-16 | **1 complete** | `session/cancel` notification; bridge + mock + `/api/cancel` + Cancel/Ctrl+.; v0.3.0 |
| 2026-07-16 | **1 review fixes** | Per-tab sending, always park cancel bubble, mock yields + sticky queued cancel, bridge env, hadPending, re-cancel while busy |
| 2026-07-16 | **2 complete** | Transcript store + API + History UI replay; v0.4.0; `~/.greg/sessions` |
| 2026-07-16 | **2 review fixes** | Await shutdown flush, buffer-safe agent write, history race guard, no DELETE while live, thoughts, tool upsert, 0o700/0o600 |

---

## How to run this plan in sessions

1. User: “zacznij Phase 0” / “continue plan”
2. Agent: open this file, find first unchecked `- [ ]` in the active phase
3. Implement **one task** (or one step group with its own commit)
4. Run gates → report → wait or continue per user
5. After phase exit: mark phase complete in Progress log; offer next phase

**Recommended execution mode:** Subagent-driven **per task** inside a phase when tasks touch different files; **inline** when editing the same hot files (`public/app.js`).

---

## Out of scope (explicit)

- Multi-user / cloud hosting
- Replacing Grok Build
- Billing, telemetry productization
- Graphify in the product
- Full IDE (LSP, multi-file editor, debugger)
- Force-push / rewriting published history
