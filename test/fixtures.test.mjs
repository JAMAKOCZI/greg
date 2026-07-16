import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  __dirname,
  "fixtures",
  "acp",
  "session-update-agent-chunk.json",
);

describe("ACP fixtures", () => {
  it("session-update-agent-chunk has the shape UI handleAcp expects", () => {
    const raw = readFileSync(FIXTURE, "utf8");
    const msg = JSON.parse(raw);

    assert.equal(msg.jsonrpc, "2.0");
    assert.equal(msg.method, "session/update");
    assert.ok(msg.params && typeof msg.params === "object");

    const update = msg.params.update || msg.params.sessionUpdate || msg.params;
    const kind = update.sessionUpdate || update.type || update.kind;
    assert.equal(kind, "agent_message_chunk");

    const text =
      update.content?.text ||
      update.text ||
      (typeof update.content === "string" ? update.content : "");
    assert.ok(typeof text === "string" && text.length > 0);
    assert.match(text, /fixture/i);
  });
});
