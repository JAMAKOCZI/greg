import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AcpBridge } from "../lib/acp-bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = join(__dirname, "..", "scripts", "mock-grok-agent.mjs");

describe("mock grok agent via AcpBridge", () => {
  it("initializes a session and streams a prompt turn", async () => {
    const bridge = new AcpBridge({
      grokBin: MOCK_BIN,
      cwd: join(__dirname, ".."),
    });

    /** @type {object[]} */
    const updates = [];
    bridge.on("notification", (msg) => {
      if (msg.method === "session/update") updates.push(msg);
    });

    try {
      const opened = await bridge.openSession({ cwd: join(__dirname, "..") });
      assert.ok(opened?.sessionId || bridge.sessionId);
      assert.match(String(bridge.sessionId), /^mock-/);

      const result = await bridge.prompt("hello mock");
      assert.equal(result?.stopReason, "end_turn");

      const kinds = updates.map(
        (u) => u.params?.update?.sessionUpdate || u.params?.update?.type,
      );
      assert.ok(
        kinds.includes("agent_message_chunk"),
        `expected agent_message_chunk in ${JSON.stringify(kinds)}`,
      );
      assert.ok(
        kinds.includes("tool_call"),
        `expected tool_call in ${JSON.stringify(kinds)}`,
      );
      assert.ok(kinds.includes("plan"), `expected plan in ${JSON.stringify(kinds)}`);
    } finally {
      bridge.stop();
    }
  });

  it("uses a unique toolCallId per prompt turn", async () => {
    const bridge = new AcpBridge({
      grokBin: MOCK_BIN,
      cwd: join(__dirname, ".."),
    });
    /** @type {string[]} */
    const toolIds = [];
    bridge.on("notification", (msg) => {
      const u = msg.params?.update;
      if (u?.sessionUpdate === "tool_call" && u.toolCallId) {
        toolIds.push(String(u.toolCallId));
      }
    });
    try {
      await bridge.openSession({ cwd: join(__dirname, "..") });
      await bridge.prompt("turn one");
      await bridge.prompt("turn two");
      assert.equal(toolIds.length, 2);
      assert.notEqual(toolIds[0], toolIds[1]);
      assert.match(toolIds[0], /^mock-tool-/);
      assert.match(toolIds[1], /^mock-tool-/);
    } finally {
      bridge.stop();
    }
  });
});
