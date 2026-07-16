# Graph Report - greg  (2026-07-16)

## Corpus Check
- 9 files · ~4,104 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 98 nodes · 138 edges · 8 communities (6 shown, 2 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1e6936e3`
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
- Greg — agent notes

## God Nodes (most connected - your core abstractions)
1. `AcpBridge` - 15 edges
2. `createGregServer()` - 8 edges
3. `Greg — agent notes` - 7 edges
4. `Greg` - 7 edges
5. `appendBubble()` - 7 edges
6. `connectStream()` - 7 edges
7. `newSession()` - 7 edges
8. `keywords` - 6 edges
9. `api()` - 5 edges
10. `sendPrompt()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `wireBridge()` --references--> `AcpBridge`  [EXTRACTED]
  server.mjs → lib/acp-bridge.mjs

## Import Cycles
- None detected.

## Communities (8 total, 2 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.11
Nodes (18): author, bin, greg, description, engines, node, license, name (+10 more)

### Community 1 - "Community 1"
Cohesion: 0.34
Nodes (14): api(), appendBubble(), appendToLive(), connectStream(), els, escapeHtml(), handleAcp(), handleAcpRequest() (+6 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (19): newClientSessionId(), cookie(), createGregServer(), __dirname, isLocalHost(), json(), MIME, newBootstrapToken() (+11 more)

### Community 4 - "Community 4"
Cohesion: 0.20
Nodes (9): Architecture, Development, Environment, Greg, Knowledge graph (graphify), License, Quick start, Requirements (+1 more)

### Community 5 - "Community 5"
Cohesion: 0.33
Nodes (6): keywords, acp, coding-agent, grok, grok-build, web-ui

### Community 7 - "Greg — agent notes"
Cohesion: 0.25
Nodes (7): Conventions, graphify, Greg — agent notes, Stack, Upstream reference, Useful commands, What this is

## Knowledge Gaps
- **41 isolated node(s):** `What this is`, `Stack`, `Conventions`, `Useful commands`, `Upstream reference` (+36 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AcpBridge` connect `Community 3` to `Community 2`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `keywords` connect `Community 5` to `Community 0`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `What this is`, `Stack`, `Conventions` to the rest of the system?**
  _41 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.12681159420289856 - nodes in this community are weakly interconnected._