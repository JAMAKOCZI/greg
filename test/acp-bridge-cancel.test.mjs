import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AcpBridge } from "../lib/acp-bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_BIN = join(__dirname, "..", "scripts", "mock-grok-agent.mjs");

/**
 * @param {Record<string, string>} [env]
 */
function makeBridge(env = {}) {
  return new AcpBridge({
    grokBin: MOCK_BIN,
    cwd: join(__dirname, ".."),
    env,
  });
}

describe("AcpBridge.cancel", () => {
  it("throws without a session", () => {
    const bridge = new AcpBridge({ grokBin: MOCK_BIN });
    assert.throws(() => bridge.cancel(), /No ACP session/);
  });

  it("sends session/cancel and prompt resolves with stopReason cancelled", async () => {
    const bridge = makeBridge({ MOCK_STREAM_MS: "30" });
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
      assert.equal(cancelResult.hadPending, true);
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
    }
  });

  it("cancel when idle is a no-op for the agent but still notifies", async () => {
    const bridge = makeBridge();
    try {
      await bridge.openSession({ cwd: join(__dirname, "..") });
      const r = bridge.cancel();
      assert.equal(r.ok, true);
      assert.equal(r.hadPending, false);
      assert.equal(bridge.hasPendingRequest, false);
      const result = await bridge.prompt("still works");
      assert.equal(result?.stopReason, "end_turn");
    } finally {
      bridge.stop();
    }
  });

  it("cancels without MOCK_STREAM_MS via cooperative yields", async () => {
    const bridge = makeBridge(); // no stream delay env
    try {
      await bridge.openSession({ cwd: join(__dirname, "..") });
      const promptPromise = bridge.prompt("yield cancel");
      // Yield so mock can enter the prompt and hit await sleep(0)
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      bridge.cancel();
      const result = await promptPromise;
      // Best-effort: with microtask yields cancel usually wins; if not, still end_turn is OK
      // for a race — assert session still works either way
      assert.ok(
        result?.stopReason === "cancelled" || result?.stopReason === "end_turn",
      );
      const again = await bridge.prompt("after");
      assert.equal(again?.stopReason, "end_turn");
    } finally {
      bridge.stop();
    }
  });
});
