#!/usr/bin/env node
/**
 * Minimal fake `grok agent stdio` for local smoke tests.
 * Speaks JSON-RPC over stdin/stdout (one message per line).
 *
 * Usage with Greg:
 *   GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start
 *
 * Optional slow streaming (cancel tests):
 *   MOCK_STREAM_MS=40 GROK_BIN=./scripts/mock-grok-agent.mjs …
 *
 * Spawned as: <this-script> agent stdio  (extra argv is ignored)
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

/** @type {string|null} */
let sessionId = null;

/** Delay between streamed updates; 0 = synchronous (default). */
const STREAM_MS = Math.max(0, Number(process.env.MOCK_STREAM_MS || 0) || 0);

/**
 * Cooperative cancel for the in-flight prompt turn.
 * @type {{ promptId: string|number, sessionId: string }|null}
 */
let activeTurn = null;
/** @type {boolean} */
let cancelRequested = false;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

/**
 * Serialize request handling so overlapping prompts do not interleave writes.
 * @type {Promise<void>}
 */
let queue = Promise.resolve();

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    write({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }

  // Notifications (no id) — handle cancel immediately so it can interrupt stream
  if (msg.id == null) {
    if (msg.method === "session/cancel") {
      handleCancel(msg.params || {});
    }
    // initialized etc. ignored
    return;
  }

  const method = msg.method;
  const id = msg.id;
  const params = msg.params || {};

  queue = queue
    .then(() => handleRequest(method, id, params))
    .catch((err) => {
      write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err?.message || String(err),
        },
      });
    });
});

rl.on("close", () => {
  process.exit(0);
});

/**
 * @param {object} params
 */
function handleCancel(params) {
  const sid = params.sessionId || sessionId;
  // Match any active turn for this session (or missing sessionId = all)
  if (!activeTurn) return;
  if (sid && activeTurn.sessionId && sid !== activeTurn.sessionId) return;
  cancelRequested = true;
}

/**
 * @param {string} method
 * @param {string|number} id
 * @param {object} params
 */
async function handleRequest(method, id, params) {
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion ?? 1,
        serverInfo: { name: "mock-grok-agent", version: "0.0.3" },
        agentCapabilities: {},
      },
    });
    return;
  }

  if (method === "session/new") {
    sessionId = `mock-${randomUUID()}`;
    write({
      jsonrpc: "2.0",
      id,
      result: { sessionId },
    });
    return;
  }

  if (method === "session/prompt") {
    const sid = params.sessionId || sessionId;
    const toolCallId = `mock-tool-${randomUUID()}`;
    cancelRequested = false;
    activeTurn = { promptId: id, sessionId: sid };

    const updates = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking (mock)… " },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "read",
        kind: "read",
        status: "completed",
        locations: [{ path: "README.md" }],
        content: [
          {
            type: "content",
            content: { type: "text", text: "# Mock read output\n" },
          },
        ],
      },
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect request", status: "completed" },
          { content: "Reply with mock text", status: "in_progress" },
        ],
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello from mock agent. " },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "Session is ready for local smoke tests.",
        },
      },
    ];

    let cancelled = false;
    for (const update of updates) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      notify("session/update", { sessionId: sid, update });
      if (STREAM_MS > 0) {
        await sleep(STREAM_MS);
        if (cancelRequested) {
          cancelled = true;
          break;
        }
      }
    }

    activeTurn = null;
    const wasCancelled = cancelled || cancelRequested;
    cancelRequested = false;

    write({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: wasCancelled ? "cancelled" : "end_turn",
      },
    });
    return;
  }

  write({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} obj
 */
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * @param {string} method
 * @param {object} params
 */
function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}
