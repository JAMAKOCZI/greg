#!/usr/bin/env node
/**
 * Minimal fake `grok agent stdio` for local smoke tests.
 * Speaks JSON-RPC over stdin/stdout (one message per line).
 *
 * Usage with Greg:
 *   GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start
 *
 * Streaming pace (optional; cancel works with default via microtask yields):
 *   MOCK_STREAM_MS=40 GROK_BIN=./scripts/mock-grok-agent.mjs …
 *
 * Spawned as: <this-script> agent stdio  (extra argv is ignored)
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

/** @type {string|null} */
let sessionId = null;

/** Delay between streamed updates; 0 still yields a microtask so cancel can run. */
const STREAM_MS = Math.max(0, Number(process.env.MOCK_STREAM_MS || 0) || 0);

/**
 * Cooperative cancel for the in-flight prompt turn.
 * @type {{ promptId: string|number, sessionId: string }|null}
 */
let activeTurn = null;
/** @type {boolean} */
let cancelRequested = false;
/** Count of session/prompt requests received but not yet finished. */
let promptDepth = 0;

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
    return;
  }

  const method = msg.method;
  const id = msg.id;
  const params = msg.params || {};

  if (method === "session/prompt") {
    promptDepth++;
  }

  queue = queue
    .then(() => handleRequest(method, id, params))
    .catch((err) => {
      if (method === "session/prompt") {
        promptDepth = Math.max(0, promptDepth - 1);
      }
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
  if (activeTurn) {
    if (sid && activeTurn.sessionId && sid !== activeTurn.sessionId) return;
    cancelRequested = true;
    return;
  }
  // Sticky only when a prompt is queued or about to start (not pure idle)
  if (promptDepth > 0) {
    cancelRequested = true;
  }
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
        serverInfo: { name: "mock-grok-agent", version: "0.0.4" },
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
    // Keep sticky cancelRequested if cancel arrived while queued
    activeTurn = { promptId: id, sessionId: sid };

    // Always yield once so a cancel sent right after prompt can land
    await sleep(0);

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

    let cancelled = cancelRequested;
    for (const update of updates) {
      if (cancelRequested) {
        cancelled = true;
        break;
      }
      notify("session/update", { sessionId: sid, update });
      // STREAM_MS=0 → microtask yield; >0 → paced stream for cancel UX demos
      await sleep(STREAM_MS);
      if (cancelRequested) {
        cancelled = true;
        break;
      }
    }

    activeTurn = null;
    const wasCancelled = cancelled || cancelRequested;
    cancelRequested = false;
    promptDepth = Math.max(0, promptDepth - 1);

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
  return new Promise((resolve) => {
    if (ms > 0) setTimeout(resolve, ms);
    else setImmediate(resolve);
  });
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
