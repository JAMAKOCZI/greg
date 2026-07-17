import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeStatus,
  extractDiffs,
  extractTextSnippets,
  looksLikeUnifiedDiff,
  lineDiff,
  unwrapSessionUpdate,
  sessionUpdateKind,
  mergeToolUpdate,
  shortFailSummary,
} from "../public/cards.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures", "acp");

function load(name) {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

describe("normalizeStatus", () => {
  it("maps common aliases", () => {
    assert.equal(normalizeStatus("in_progress"), "running");
    assert.equal(normalizeStatus("IN-PROGRESS"), "running");
    assert.equal(normalizeStatus("completed"), "completed");
    assert.equal(normalizeStatus("failed"), "failed");
    assert.equal(normalizeStatus("cancelled"), "failed");
    assert.equal(normalizeStatus(""), "pending");
  });
});

describe("shortFailSummary", () => {
  it("maps deserialize transport errors to a short line", () => {
    const s = shortFailSummary(
      'Failed to read file: C:\\x\\strona krzesła\\index.html, IO Error: Internal error: "failed to deserialize response"',
    );
    assert.match(s, /Could not read file/i);
    assert.ok(s.length < 120);
  });

  it("truncates long messages", () => {
    const s = shortFailSummary("x".repeat(500), 40);
    assert.ok(s.length <= 40);
    assert.ok(s.endsWith("…"));
  });
});

describe("looksLikeUnifiedDiff / lineDiff", () => {
  it("detects git-style patches", () => {
    const p =
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
    assert.equal(looksLikeUnifiedDiff(p), true);
  });

  it("does not treat shell +/- logs as diffs", () => {
    const log = "- waiting\n+ running\n- done\n+ ok\n";
    assert.equal(looksLikeUnifiedDiff(log), false);
    assert.equal(extractDiffs({ content: [{ type: "content", content: { type: "text", text: log } }] }).length, 0);
  });

  it("lineDiff marks adds and dels", () => {
    const lines = lineDiff("a\nb\n", "a\nc\n");
    const kinds = lines.map((l) => l.kind);
    assert.ok(kinds.includes("del"));
    assert.ok(kinds.includes("add"));
  });
});

describe("mergeToolUpdate", () => {
  it("preserves content when update has empty array", () => {
    const prev = {
      toolCallId: "t1",
      status: "pending",
      content: [{ type: "diff", path: "a.js", oldText: "a", newText: "b" }],
    };
    const next = mergeToolUpdate(prev, {
      toolCallId: "t1",
      status: "in_progress",
      content: [],
    });
    assert.equal(next.status, "in_progress");
    assert.equal(next.content.length, 1);
    assert.equal(extractDiffs(next).length, 1);
  });

  it("preserves rawInput when status-only update", () => {
    const prev = {
      rawInput: { file_path: "x", old_string: "a", new_string: "b" },
      status: "pending",
    };
    const next = mergeToolUpdate(prev, { status: "completed" });
    assert.deepEqual(next.rawInput, prev.rawInput);
    assert.equal(extractDiffs(next).length, 1);
  });

  it("preserves content when update has sparse non-empty content[]", () => {
    const prev = {
      toolCallId: "t1",
      status: "pending",
      content: [
        { type: "diff", path: "a.js", oldText: "a", newText: "b" },
      ],
    };
    const next = mergeToolUpdate(prev, {
      toolCallId: "t1",
      status: "completed",
      // Sparse stub — no old/new — must not wipe prior diff
      content: [{ type: "diff", path: "a.js" }],
    });
    assert.equal(next.status, "completed");
    assert.equal(extractDiffs(next).length, 1);
    assert.equal(extractDiffs(next)[0].oldText, "a");
  });
});

describe("extractDiffs edge cases", () => {
  it("content[] with file_path + old_string (no type:diff)", () => {
    const diffs = extractDiffs({
      sessionUpdate: "tool_call",
      content: [
        {
          file_path: "lib/x.mjs",
          old_string: "const a = 1;\n",
          new_string: "const a = 2;\n",
        },
      ],
    });
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, "lib/x.mjs");
  });

  it("does not treat { path, new: true } as a text diff", () => {
    const diffs = extractDiffs({
      path: "foo.js",
      new: true,
      old: false,
    });
    assert.equal(diffs.length, 0);
  });

  it("extractTextSnippets unwraps full notifications", () => {
    const msg = load("tool-call-read.json");
    const texts = extractTextSnippets(msg);
    assert.ok(texts.some((t) => t.includes("Anonymized")));
  });
});

describe("ACP fixtures — tool shapes", () => {
  it("loads at least 3 tool_call fixtures", () => {
    const files = readdirSync(FIX).filter((f) => f.startsWith("tool-call"));
    assert.ok(files.length >= 3, `expected >=3 tool fixtures, got ${files.length}`);
  });

  it("tool-call-read: locations + text content", () => {
    const msg = load("tool-call-read.json");
    assert.equal(sessionUpdateKind(msg), "tool_call");
    const u = unwrapSessionUpdate(msg);
    assert.equal(u.toolCallId, "call_read_01");
    assert.equal(normalizeStatus(u.status), "completed");
    const texts = extractTextSnippets(u);
    assert.ok(texts.some((t) => t.includes("Anonymized")));
    assert.equal(extractDiffs(u).length, 0);
  });

  it("tool-call-edit-diff: content type=diff with oldText/newText", () => {
    const msg = load("tool-call-edit-diff.json");
    const diffs = extractDiffs(msg);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, "src/app.js");
    assert.ok(String(diffs[0].oldText).includes("0.1.0"));
    assert.ok(String(diffs[0].newText).includes("0.2.0"));
    const lines = lineDiff(diffs[0].oldText, diffs[0].newText);
    assert.ok(lines.some((l) => l.kind === "del"));
    assert.ok(lines.some((l) => l.kind === "add"));
  });

  it("tool-call-edit-rawinput: file_path + old_string/new_string", () => {
    const msg = load("tool-call-edit-rawinput.json");
    const diffs = extractDiffs(msg);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, "lib/http.mjs");
    assert.ok(String(diffs[0].oldText).includes("json(res, status, body)"));
    assert.ok(String(diffs[0].newText).includes("headers"));
  });

  it("tool-call-bash: text output without false diffs", () => {
    const msg = load("tool-call-bash.json");
    const u = unwrapSessionUpdate(msg);
    assert.equal(normalizeStatus(u.status), "completed");
    const texts = extractTextSnippets(u);
    assert.ok(texts.some((t) => t.includes("pass 10")));
    assert.equal(extractDiffs(u).length, 0);
  });

  it("tool-call-update-running: status normalize", () => {
    const msg = load("tool-call-update-running.json");
    assert.equal(sessionUpdateKind(msg), "tool_call_update");
    const u = unwrapSessionUpdate(msg);
    assert.equal(normalizeStatus(u.status), "running");
    assert.equal(u.toolCallId, "call_edit_01");
  });

  it("tool-call-unified-patch: rawOutput unified diff", () => {
    const msg = load("tool-call-unified-patch.json");
    const diffs = extractDiffs(msg);
    assert.equal(diffs.length, 1);
    assert.ok(diffs[0].unified);
    assert.match(diffs[0].path, /hello\.txt/);
  });
});

describe("ACP fixtures — plan + diff_review", () => {
  it("plan entries", () => {
    const msg = load("plan-entries.json");
    assert.equal(sessionUpdateKind(msg), "plan");
    const u = unwrapSessionUpdate(msg);
    assert.equal(u.entries.length, 3);
    assert.equal(normalizeStatus(u.entries[0].status), "completed");
    assert.equal(normalizeStatus(u.entries[1].status), "running");
  });

  it("diff_review content array (Grok Build shape)", () => {
    const msg = load("diff-review.json");
    assert.equal(sessionUpdateKind(msg), "diff_review");
    const diffs = extractDiffs(msg);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].path, "src/main.rs");
    assert.equal(diffs[0].oldText, "fn old() {}");
    assert.equal(diffs[0].newText, "fn new() {}");
  });
});
