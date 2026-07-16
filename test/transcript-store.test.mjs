import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptStore } from "../lib/transcript-store.mjs";

describe("TranscriptStore", () => {
  /** @type {string} */
  let root;
  /** @type {TranscriptStore} */
  let store;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-tx-"));
    store = new TranscriptStore({ rootDir: root });
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("create + load round-trip", async () => {
    const doc = await store.create({
      id: "sess-a",
      cwd: "/home/u/proj",
      title: "Hello",
    });
    assert.equal(doc.id, "sess-a");
    assert.equal(doc.messages.length, 0);

    const loaded = await store.load("sess-a");
    assert.ok(loaded);
    assert.equal(loaded.cwd, "/home/u/proj");
    assert.equal(loaded.title, "Hello");
  });

  it("appendMessage persists and updates updatedAt", async () => {
    await store.create({ id: "sess-b", cwd: "/x" });
    const before = await store.load("sess-b");
    await new Promise((r) => setTimeout(r, 5));
    const after = await store.appendMessage("sess-b", {
      role: "user",
      text: "hi",
    });
    assert.ok(after);
    assert.equal(after.messages.length, 1);
    assert.equal(after.messages[0].role, "user");
    assert.equal(after.messages[0].text, "hi");
    assert.ok(after.updatedAt >= before.updatedAt);

    const again = await store.load("sess-b");
    assert.equal(again.messages.length, 1);
  });

  it("list sorts by updatedAt descending", async () => {
    const a = await store.create({ id: "sort-a", cwd: "/a" });
    const b = await store.create({ id: "sort-b", cwd: "/b" });
    // Force known timestamps on disk
    a.updatedAt = 1000;
    await store.save(a);
    b.updatedAt = 5000;
    await store.save(b);
    // save() overwrites updatedAt with Date.now — re-read and compare relative after bump
    await store.appendMessage("sort-a", { role: "system", text: "bump a" });
    const list = await store.list();
    const aSum = list.find((s) => s.id === "sort-a");
    const bSum = list.find((s) => s.id === "sort-b");
    assert.ok(aSum && bSum);
    // sort-a was just appended → should be more recent than sort-b's last save
    assert.ok(
      aSum.updatedAt >= bSum.updatedAt,
      `expected sort-a (${aSum.updatedAt}) >= sort-b (${bSum.updatedAt})`,
    );
    assert.ok(list.indexOf(aSum) < list.indexOf(bSum));
  });

  it("delete removes file", async () => {
    await store.create({ id: "gone", cwd: "/z" });
    assert.equal(await store.delete("gone"), true);
    assert.equal(await store.load("gone"), null);
    assert.equal(await store.delete("gone"), true); // force ok
  });

  it("rejects path-traversal ids", async () => {
    assert.throws(() => store.pathFor("../evil"), /Invalid/);
    assert.throws(() => store.pathFor("a/b"), /Invalid/);
  });

  it("atomic write leaves valid JSON file", async () => {
    await store.create({ id: "atom", cwd: "/c" });
    await store.appendMessage("atom", { role: "agent", text: "ok" });
    const raw = await readFile(join(root, "atom.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.messages.length, 1);
  });

  it("setTitle updates disk", async () => {
    await store.create({ id: "t1", cwd: "/t" });
    await store.setTitle("t1", "  Named  ");
    const doc = await store.load("t1");
    assert.equal(doc.title, "Named");
  });

  it("appendMessage returns null for missing id", async () => {
    assert.equal(
      await store.appendMessage("nope", { role: "user", text: "x" }),
      null,
    );
  });

  it("serializes concurrent appendMessage without corruption", async () => {
    await store.create({ id: "race", cwd: "/r" });
    const n = 40;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.appendMessage("race", { role: "system", text: `m${i}` }),
      ),
    );
    const doc = await store.load("race");
    assert.ok(doc);
    assert.equal(doc.messages.length, n);
    // File must parse as a single JSON value (no concat garbage)
    const raw = await readFile(join(root, "race.json"), "utf8");
    JSON.parse(raw);
  });
});
