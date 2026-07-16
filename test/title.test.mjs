import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { titleFromPrompt } from "../lib/text.mjs";

describe("titleFromPrompt", () => {
  it("returns short prompts unchanged", () => {
    assert.equal(titleFromPrompt("Fix the bug"), "Fix the bug");
  });

  it("collapses whitespace to a single line", () => {
    assert.equal(titleFromPrompt("  hello   \n  world  "), "hello world");
  });

  it("truncates long prompts at 40 chars with an ellipsis", () => {
    const long = "a".repeat(50);
    const title = titleFromPrompt(long);
    assert.equal(title.length, 41); // 40 + …
    assert.equal(title, `${"a".repeat(40)}…`);
  });

  it("trims trailing spaces before adding ellipsis", () => {
    // 38 chars + two spaces would overflow if not trimmed
    const text = `${"b".repeat(38)}  extra`;
    const title = titleFromPrompt(text);
    assert.ok(title.endsWith("…"));
    assert.ok(title.length <= 41);
    assert.equal(title.includes("  "), false);
  });

  it("handles empty string", () => {
    assert.equal(titleFromPrompt(""), "");
  });
});
