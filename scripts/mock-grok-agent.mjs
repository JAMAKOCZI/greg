#!/usr/bin/env node
/**
 * Minimal fake `grok agent stdio` for local smoke tests.
 * Speaks JSON-RPC over stdin/stdout (one message per line).
 *
 * Usage with Greg:
 *   GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start
 *
 * Optional slow streaming (Phase 1 cancel prep):
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

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

/**
 * Serialize prompt handling so overlapping prompts do not interleave writes.
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

  // Client notifications (e.g. initialized) — ignore
  if (msg.id == null) return;

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
        serverInfo: { name: "mock-grok-agent", version: "0.0.2" },
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

    for (const update of updates) {
      notify("session/update", { sessionId: sid, update });
      if (STREAM_MS > 0) await sleep(STREAM_MS);
    }

    write({
      jsonrpc: "2.0",
      id,
      result: { stopReason: "end_turn" },
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
