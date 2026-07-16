# Greg — agent notes

## What this is

Local **Codex-style web UI** for Grok Build. Browser → Greg HTTP/SSE → `grok agent stdio` (ACP).

## Stack

- Node.js ≥ 20, ESM, zero runtime dependencies
- `server.mjs` + `lib/*` + `public/*`

## Conventions

- Commits: Conventional Commits, English
- Keep Greg as a **thin shell** — do not reimplement the agent loop
- Bind to localhost only; never default to `0.0.0.0`
- No secrets in repo; do not commit `~/.grok/auth.json`

## Useful commands

```sh
npm start
npm run check
npm test
GROK_BIN=/path/to/grok GREG_CWD=/path/to/project npm start
```

### Mock agent (no `grok login` required)

For local smoke without the real Grok Build binary:

```sh
GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start
```

`scripts/mock-grok-agent.mjs` speaks minimal ACP over stdio (`initialize`, `session/new`, `session/prompt` + a few `session/update` events). Covered by `test/mock-agent.test.mjs`.

Optional: `MOCK_STREAM_MS=40` spaces updates so mid-turn cancel can be tested later.

## Upstream reference

Official harness source (for ACP shapes): `xai-org/grok-build` — especially agent mode / ACP docs.

## Optional: local graphify (maintainers / agents only)

Graphify is **dev tooling**, not a Greg product feature. End users never install or run it. Do not add graphify as a runtime dependency, UI surface, or install step in product docs.

If `graphify-out/graph.json` exists **locally** (gitignored; not shipped):

- Prefer `graphify query` / `path` / `explain` for architecture questions before mass-grep.
- After code edits, `graphify update .` (or a local post-commit hook) keeps the graph fresh.
- If the graph is missing, work without it — never block on graphify.
