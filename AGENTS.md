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

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
