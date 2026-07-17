import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildToolMetaFromUpdate,
  clipForTranscript,
  collapseTranscriptMessages,
  mergeToolMeta,
  toolSummaryText,
} from "../lib/transcript-messages.mjs";

describe("collapseTranscriptMessages", () => {
  it("drops identical consecutive agent rows", () => {
    const out = collapseTranscriptMessages([
      { role: "user", text: "hi" },
      { role: "agent", text: "hello" },
      { role: "agent", text: "hello" },
      { role: "agent", text: "hello" },
      { role: "tool", text: "x" },
    ]);
    assert.equal(out.filter((m) => m.role === "agent").length, 1);
    assert.equal(out.length, 3);
  });

  it("keeps the longer agent text when one is a prefix of the other", () => {
    const t0 = 1_000_000;
    const out = collapseTranscriptMessages([
      { role: "agent", text: "Hello", ts: t0 },
      { role: "agent", text: "Hello world", ts: t0 + 50 },
      { role: "agent", text: "Hello world!", ts: t0 + 100 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "Hello world!");
  });

  it("does not prefix-collapse agent turns far apart in time", () => {
    const t0 = 1_000_000;
    const out = collapseTranscriptMessages([
      { role: "agent", text: "OK", ts: t0 },
      { role: "agent", text: "OK, here is the full answer", ts: t0 + 60_000 },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].text, "OK");
    assert.equal(out[1].text, "OK, here is the full answer");
  });

  it("drops decorative-only agent rows", () => {
    const out = collapseTranscriptMessages([
      { role: "agent", text: "---" },
      { role: "agent", text: "hello" },
      { role: "agent", text: "\n***\n" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "hello");
  });

  it("keeps distinct agent messages", () => {
    const out = collapseTranscriptMessages([
      { role: "agent", text: "A" },
      { role: "tool", text: "t" },
      { role: "agent", text: "B" },
    ]);
    assert.equal(out.length, 3);
  });
});

describe("mergeToolMeta", () => {
  it("does not wipe content when status-only update arrives", () => {
    const merged = mergeToolMeta(
      {
        toolCallId: "t1",
        status: "running",
        content: [{ type: "text", text: "out" }],
        rawInput: { command: "ls" },
      },
      { toolCallId: "t1", status: "completed", content: [] },
    );
    assert.equal(merged.status, "completed");
    assert.deepEqual(merged.content, [{ type: "text", text: "out" }]);
    assert.deepEqual(merged.rawInput, { command: "ls" });
  });
});

describe("buildToolMetaFromUpdate", () => {
  it("captures title status and payloads", () => {
    const meta = buildToolMetaFromUpdate({
      toolCallId: "call_1",
      title: "Execute `ls`",
      kind: "execute",
      status: "completed",
      rawInput: { command: "ls" },
      rawOutput: "a\nb\n",
      content: [
        {
          type: "content",
          content: { type: "text", text: "a\nb\n" },
        },
      ],
    });
    assert.equal(meta.toolCallId, "call_1");
    assert.equal(meta.status, "completed");
    assert.equal(meta.kind, "execute");
    assert.equal(meta.rawOutput, "a\nb\n");
    assert.ok(Array.isArray(meta.content));
  });
});

describe("toolSummaryText", () => {
  it("formats title · status", () => {
    assert.equal(
      toolSummaryText({ title: "read_file", status: "completed" }),
      "read_file · completed",
    );
  });
});

describe("clipForTranscript", () => {
  it("truncates long strings", () => {
    const s = "x".repeat(50);
    const clipped = clipForTranscript(s, 20);
    assert.equal(typeof clipped, "string");
    assert.ok(String(clipped).startsWith("x".repeat(20)));
    assert.match(String(clipped), /truncated/);
  });
});
