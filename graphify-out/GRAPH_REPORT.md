# Graph Report - .  (2026-07-16)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 80 nodes · 122 edges · 7 communities (5 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `557eaf87`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6

## God Nodes (most connected - your core abstractions)
1. `AcpBridge` - 15 edges
2. `createGregServer()` - 8 edges
3. `appendBubble()` - 7 edges
4. `connectStream()` - 7 edges
5. `newSession()` - 7 edges
6. `keywords` - 6 edges
7. `api()` - 5 edges
8. `sendPrompt()` - 5 edges
9. `scripts` - 4 edges
10. `setStatus()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `wireBridge()` --references--> `AcpBridge`  [EXTRACTED]
  server.mjs → lib/acp-bridge.mjs

## Import Cycles
- None detected.

## Communities (7 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.11
Nodes (18): author, bin, greg, description, engines, node, license, name (+10 more)

### Community 1 - "Community 1"
Cohesion: 0.34
Nodes (14): api(), appendBubble(), appendToLive(), connectStream(), els, escapeHtml(), handleAcp(), handleAcpRequest() (+6 more)

### Community 2 - "Community 2"
Cohesion: 0.21
Nodes (13): cookie(), createGregServer(), __dirname, isLocalHost(), json(), MIME, newBootstrapToken(), newSessionSecret() (+5 more)

### Community 4 - "Community 4"
Cohesion: 0.20
Nodes (7): newClientSessionId(), bootstrapToken, PORT, server, sessionSecret, tabs, wireBridge()

### Community 5 - "Community 5"
Cohesion: 0.33
Nodes (6): keywords, acp, coding-agent, grok, grok-build, web-ui

## Knowledge Gaps
- **29 isolated node(s):** `root`, `__dirname`, `PUBLIC_DIR`, `MIME`, `name` (+24 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AcpBridge` connect `Community 3` to `Community 4`?**
  _High betweenness centrality (0.113) - this node is a cross-community bridge._
- **Why does `keywords` connect `Community 5` to `Community 0`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Why does `createGregServer()` connect `Community 2` to `Community 4`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **What connects `root`, `__dirname`, `PUBLIC_DIR` to the rest of the system?**
  _29 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._