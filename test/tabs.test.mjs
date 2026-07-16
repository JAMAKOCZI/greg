import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TabRegistry, tabMeta } from "../lib/tabs.mjs";

function fakeBridge(overrides = {}) {
  return {
    sessionId: "sess-1",
    alive: true,
    stop() {},
    ...overrides,
  };
}

describe("TabRegistry", () => {
  it("create + get + meta", () => {
    const reg = new TabRegistry();
    reg.create("t1", { bridge: fakeBridge(), cwd: "/home/u/proj" });
    const entry = reg.get("t1");
    assert.ok(entry);
    assert.equal(entry.cwd, "/home/u/proj");
    assert.equal(entry.title, null);

    const meta = reg.meta("t1");
    assert.equal(meta.tabId, "t1");
    assert.equal(meta.cwdBase, "proj");
    assert.equal(meta.sessionId, "sess-1");
    assert.equal(meta.alive, true);
  });

  it("list sorts by lastActiveAt descending", () => {
    const reg = new TabRegistry();
    reg.create("old", {
      bridge: fakeBridge({ sessionId: "a" }),
      cwd: "/a",
      createdAt: 1000,
      lastActiveAt: 1000,
    });
    reg.create("new", {
      bridge: fakeBridge({ sessionId: "b" }),
      cwd: "/b",
      createdAt: 2000,
      lastActiveAt: 5000,
    });
    reg.create("mid", {
      bridge: fakeBridge({ sessionId: "c" }),
      cwd: "/c",
      createdAt: 1500,
      lastActiveAt: 3000,
    });

    const ids = reg.list().map((t) => t.tabId);
    assert.deepEqual(ids, ["new", "mid", "old"]);
  });

  it("touch updates lastActiveAt", () => {
    const reg = new TabRegistry();
    reg.create("t1", {
      bridge: fakeBridge(),
      cwd: "/x",
      lastActiveAt: 1,
    });
    reg.touch("t1", 99);
    assert.equal(reg.get("t1").lastActiveAt, 99);
  });

  it("setTitle trims and clears empty", () => {
    const reg = new TabRegistry();
    reg.create("t1", { bridge: fakeBridge(), cwd: "/x" });
    reg.setTitle("t1", "  Hello  ", 10);
    assert.equal(reg.get("t1").title, "Hello");
    assert.equal(reg.get("t1").lastActiveAt, 10);
    reg.setTitle("t1", "   ", 11);
    assert.equal(reg.get("t1").title, null);
  });

  it("ensureTitleFromPrompt only sets when missing", () => {
    const reg = new TabRegistry();
    reg.create("t1", { bridge: fakeBridge(), cwd: "/x" });
    const first = reg.ensureTitleFromPrompt("t1", "first prompt here", 20);
    assert.equal(first, "first prompt here");
    const second = reg.ensureTitleFromPrompt("t1", "second should not win", 30);
    assert.equal(second, "first prompt here");
    assert.equal(reg.get("t1").lastActiveAt, 30);
  });

  it("ensureTitleFromPrompt truncates long prompts", () => {
    const reg = new TabRegistry();
    reg.create("t1", { bridge: fakeBridge(), cwd: "/x" });
    const title = reg.ensureTitleFromPrompt("t1", "x".repeat(50));
    assert.equal(title, `${"x".repeat(40)}…`);
  });

  it("delete removes tab", () => {
    const reg = new TabRegistry();
    reg.create("t1", { bridge: fakeBridge(), cwd: "/x" });
    assert.equal(reg.delete("t1"), true);
    assert.equal(reg.has("t1"), false);
    assert.equal(reg.meta("t1"), null);
    assert.equal(reg.list().length, 0);
  });

  it("tabMeta reports dead bridges", () => {
    const meta = tabMeta("t1", {
      bridge: { sessionId: "s", alive: false },
      sse: new Set(),
      cwd: "/tmp/foo",
      title: null,
      createdAt: 1,
      lastActiveAt: 2,
    });
    assert.equal(meta.alive, false);
    assert.equal(meta.cwdBase, "foo");
  });
});
