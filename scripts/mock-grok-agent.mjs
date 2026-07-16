#!/usr/bin/env node
/**
 * Minimal fake `grok agent stdio` for local smoke tests.
 * Speaks JSON-RPC over stdin/stdout (one message per line).
 *
 * Usage with Greg:
 *   GROK_BIN=./scripts/mock-grok-agent.mjs GREG_NO_OPEN=1 npm start
 *
 * Spawned as: <this-script> agent stdio  (extra argv is ignored)
 */
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

/** @type {string|null} */
let sessionId = null;

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

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

  // Responses only for requests with id
  if (msg.id == null) {
    // Client notifications (e.g. initialized) — ignore
    return;
  }

  const method = msg.method;
  const id = msg.id;
  const params = msg.params || {};

  try {
    if (method === "initialize") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params.protocolVersion ?? 1,
          serverInfo: { name: "mock-grok-agent", version: "0.0.1" },
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
      // Stream a short turn: thought → tool → plan → message
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking (mock)… " },
        },
      });
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "mock-tool-1",
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
      });
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Inspect request", status: "completed" },
            { content: "Reply with mock text", status: "in_progress" },
          ],
        },
      });
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from mock agent. " },
        },
      });
      notify("session/update", {
        sessionId: sid,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Session is ready for local smoke tests.",
          },
        },
      });
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
  } catch (err) {
    write({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err?.message || String(err),
      },
    });
  }
});

rl.on("close", () => {
  process.exit(0);
});

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
