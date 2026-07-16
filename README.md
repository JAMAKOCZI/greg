# Greg

**Codex-style local web workspace for [Grok Build](https://x.ai/cli).**

Greg is a browser UI that runs on your machine and talks to the official `grok` agent over **ACP** (`grok agent stdio`). The agent harness stays in Grok Build — Greg is the desk.

> Independent community project. **Not** affiliated with, endorsed by, or sponsored by xAI / SpaceXAI. Grok and Grok Build are trademarks of their respective owners.

## Status

Early (`0.3.0`). Multi-session desk, permission cards, tool/diff/plan cards, and **cancel turn** (`Ctrl+.` / Cancel button) over ACP. Phase 0 foundation: `npm test`, mock agent. Disk session history and workspace switcher still to come.

## Requirements

- **Node.js** ≥ 20
- **[Grok Build CLI](https://x.ai/cli)** on `PATH` (`grok`)
- Authenticated Grok account: `grok login`

```sh
curl -fsSL https://x.ai/cli/install.sh | bash
grok login
```

## Quick start

```sh
git clone https://github.com/JAMAKOCZI/greg.git
cd greg
npm start
```

Greg prints a one-time local URL (token-gated), e.g.:

```
http://127.0.0.1:7842/?token=...
```

Open it in your browser. The server binds to **localhost only**.

### Environment

| Variable     | Default | Meaning                          |
| ------------ | ------- | -------------------------------- |
| `PORT`       | `0`     | HTTP port (`0` = random free)    |
| `GROK_BIN`   | `grok`  | Path to Grok Build binary        |
| `GREG_CWD`   | cwd     | Initial workspace for new sessions |
| `GREG_NO_OPEN` | unset | Set to `1` to skip opening a browser |

## Architecture

```
Browser  ──HTTP/SSE──►  Greg server  ──JSON-RPC/stdio──►  grok agent stdio
```

- **Greg** owns the UI, local auth cookie, project picker, and permission cards.
- **Grok Build** owns tools, models, plan mode, subagents, MCP, and sandboxing.

See [docs/architecture.md](docs/architecture.md).

## Development

```sh
npm run dev      # restart on file changes
npm run check    # syntax check (server + lib)
npm test         # unit + mock ACP bridge tests (node:test)
```

### Mock agent (no Grok login)

Smoke the full desk without a real `grok` binary:

```sh
GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start
```

Open the printed one-time URL → **New session** → send a prompt. The mock speaks minimal ACP over stdio.

Optional slow stream (for cancel experiments): `MOCK_STREAM_MS=40 GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start`.

Quality roadmap (phased, step-by-step): [docs/superpowers/plans/2026-07-16-codex-quality-roadmap.md](docs/superpowers/plans/2026-07-16-codex-quality-roadmap.md).

Optional maintainer tooling (knowledge graph, editor hooks, etc.) is **not** part of Greg’s runtime and is never required to run or ship the app. See `AGENTS.md` if you contribute with an AI coding agent.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

Grok Build itself is Apache-2.0 from xAI; Greg does not redistribute that binary.
