import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyContextSeed,
  buildResumeContextSeed,
  DEFAULT_MAX_CHARS,
} from "../lib/resume-context.mjs";

describe("buildResumeContextSeed", () => {
  it("returns null for empty or non-array input", () => {
    assert.equal(buildResumeContextSeed([]), null);
    assert.equal(buildResumeContextSeed(/** @type {any} */ (null)), null);
  });

  it("formats user and agent turns", () => {
    const seed = buildResumeContextSeed([
      { role: "user", text: "Add dark mode" },
      { role: "agent", text: "I'll add a theme toggle." },
    ]);
    assert.ok(seed);
    assert.match(seed.text, /User: Add dark mode/);
    assert.match(seed.text, /Assistant: I'll add a theme toggle\./);
    assert.match(seed.text, /Prior conversation context restored by Greg/);
    assert.match(seed.text, /End of restored context/);
    assert.equal(seed.messageCount, 2);
    assert.equal(seed.truncated, false);
  });

  it("skips system, thought, and permission roles", () => {
    const seed = buildResumeContextSeed([
      { role: "system", text: "Session resumed — continue in this chat" },
      { role: "thought", text: "internal chain" },
      { role: "permission", text: "Allow bash?" },
      { role: "user", text: "hi" },
      { role: "agent", text: "hello" },
    ]);
    assert.ok(seed);
    assert.equal(seed.messageCount, 2);
    assert.equal(seed.text.includes("Session resumed"), false);
    assert.equal(seed.text.includes("internal chain"), false);
    assert.equal(seed.text.includes("Allow bash"), false);
  });

  it("includes compact tool and plan lines", () => {
    const seed = buildResumeContextSeed([
      {
        role: "tool",
        text: "file contents…",
        meta: { title: "read README.md", status: "completed", kind: "read" },
      },
      { role: "plan", text: "1. Inspect\n2. Edit" },
      { role: "user", text: "go" },
    ]);
    assert.ok(seed);
    assert.match(seed.text, /Tool: read README\.md \(completed\)/);
    assert.match(seed.text, /Plan: 1\. Inspect/);
  });

  it("keeps the most recent messages under maxMessages", () => {
    const messages = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: "user", text: `msg-${i}` });
    }
    const seed = buildResumeContextSeed(messages, { maxMessages: 3 });
    assert.ok(seed);
    assert.equal(seed.messageCount, 3);
    assert.equal(seed.truncated, true);
    assert.match(seed.text, /msg-9/);
    assert.match(seed.text, /msg-7/);
    assert.equal(seed.text.includes("msg-0"), false);
    assert.match(seed.text, /omitted to fit the context budget/);
  });

  it("respects maxChars by dropping older turns", () => {
    const messages = [
      { role: "user", text: "A".repeat(200) },
      { role: "agent", text: "B".repeat(200) },
      { role: "user", text: "recent question" },
      { role: "agent", text: "recent answer" },
    ];
    const seed = buildResumeContextSeed(messages, {
      maxChars: 600,
      maxPerMessage: 200,
    });
    assert.ok(seed);
    assert.match(seed.text, /recent question/);
    assert.ok(seed.charCount <= 600 + 50); // small slack for header note
    assert.ok(seed.charCount <= DEFAULT_MAX_CHARS);
  });

  it("clips oversized single messages", () => {
    const seed = buildResumeContextSeed(
      [{ role: "user", text: "x".repeat(5000) }],
      { maxPerMessage: 100 },
    );
    assert.ok(seed);
    assert.match(seed.text, /User: x{10,}…/);
    assert.ok(seed.text.length < 5000);
  });
});

describe("applyContextSeed", () => {
  it("returns user text when seed is empty", () => {
    assert.equal(applyContextSeed("hello", null), "hello");
    assert.equal(applyContextSeed("hello", ""), "hello");
    assert.equal(applyContextSeed("hello", "   "), "hello");
  });

  it("prepends seed with delimiter before user message", () => {
    const out = applyContextSeed("do the thing", "SEED BODY");
    assert.match(out, /^SEED BODY\n\n---\n\nUser's new message:\ndo the thing$/);
  });
});
