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
GROK_BIN=/path/to/grok GREG_CWD=/path/to/project npm start
```

## Upstream reference

Official harness source (for ACP shapes): `xai-org/grok-build` — especially agent mode / ACP docs.
