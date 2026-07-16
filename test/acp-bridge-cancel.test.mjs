import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AcpBridge } from "../lib/acp-bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = join(__dirname, "..", "scripts", "mock-grok-agent.mjs");

function makeBridge(env = {}) {
  // Pass MOCK_STREAM_MS via child env by wrapping is hard; set process.env
  // for the spawn (bridge inherits process.env).
  for (const [k, v] of Object.entries(env)) {
    if (v == null) delete process.env[k];
    else process.env[k] = String(v);
  }
  return new AcpBridge({
    grokBin: MOCK_BIN,
    cwd: join(__dirname, ".."),
  });
}

describe("AcpBridge.cancel", () => {
  it("throws without a session", () => {
    const bridge = new AcpBridge({ grokBin: MOCK_BIN });
    assert.throws(() => bridge.cancel(), /No ACP session/);
  });

  it("sends session/cancel and prompt resolves with stopReason cancelled", async () => {
    const prev = process.env.MOCK_STREAM_MS;
    process.env.MOCK_STREAM_MS = "30";
    const bridge = makeBridge();
    /** @type {object[]} */
    const cancelEvents = [];
    bridge.on("cancel", (p) => cancelEvents.push(p));

    try {
      await bridge.openSession({ cwd: join(__dirname, "..") });
      assert.ok(bridge.sessionId);

      const promptPromise = bridge.prompt("long turn please");
      // Let mock start streaming
      await new Promise((r) => setTimeout(r, 45));
      assert.equal(bridge.hasPendingRequest, true);

      const cancelResult = bridge.cancel({ reason: "user" });
      assert.equal(cancelResult.ok, true);
      assert.equal(cancelResult.sessionId, bridge.sessionId);
      assert.equal(cancelEvents.length, 1);
      assert.equal(cancelEvents[0].reason, "user");

      const result = await promptPromise;
      assert.equal(result?.stopReason, "cancelled");
      assert.equal(bridge.hasPendingRequest, false);

      // Session remains usable for a new prompt
      const again = await bridge.prompt("after cancel");
      assert.equal(again?.stopReason, "end_turn");
    } finally {
      bridge.stop();
      if (prev === undefined) delete process.env.MOCK_STREAM_MS;
      else process.env.MOCK_STREAM_MS = prev;
    }
  });

  it("cancel when idle is a no-op for the agent but still notifies", async () => {
    const bridge = makeBridge();
    try {
      await bridge.openSession({ cwd: join(__dirname, "..") });
      const r = bridge.cancel();
      assert.equal(r.ok, true);
      // No pending prompt — still fine
      assert.equal(bridge.hasPendingRequest, false);
      const result = await bridge.prompt("still works");
      assert.equal(result?.stopReason, "end_turn");
    } finally {
      bridge.stop();
    }
  });
});
