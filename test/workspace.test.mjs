import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveWorkspace, RecentsStore } from "../lib/workspace.mjs";

describe("resolveWorkspace", () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-ws-"));
    await mkdir(join(root, "proj"));
    await writeFile(join(root, "file.txt"), "x");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("rejects empty path", async () => {
    const r = await resolveWorkspace("  ");
    assert.equal(r.ok, false);
    assert.equal(r.code, "EMPTY");
  });

  it("resolves absolute existing directory", async () => {
    const r = await resolveWorkspace(join(root, "proj"));
    assert.equal(r.ok, true);
    assert.equal(r.path, join(root, "proj"));
    assert.equal(r.base, "proj");
  });

  it("resolves relative path against base", async () => {
    const r = await resolveWorkspace("proj", { base: root });
    assert.equal(r.ok, true);
    assert.equal(r.path, join(root, "proj"));
  });

  it("rejects missing path", async () => {
    const r = await resolveWorkspace(join(root, "nope"));
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
  });

  it("rejects file when directory required", async () => {
    const r = await resolveWorkspace(join(root, "file.txt"));
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_DIR");
  });

  it("allows missing when mustExist false", async () => {
    const r = await resolveWorkspace(join(root, "future"), {
      mustExist: false,
    });
    assert.equal(r.ok, true);
    assert.ok(r.path.endsWith("future"));
  });

  it("expands ~", async () => {
    const r = await resolveWorkspace("~", { mustExist: true });
    assert.equal(r.ok, true);
    assert.equal(r.path, homedir());
  });
});

describe("RecentsStore", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let file;
  /** @type {RecentsStore} */
  let store;
  /** @type {string} */
  let a;
  /** @type {string} */
  let b;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-rec-"));
    file = join(root, "recents.json");
    store = new RecentsStore({ filePath: file, max: 3 });
    a = join(root, "a");
    b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("touch adds and MRU-orders", async () => {
    await store.touch(a);
    await store.touch(b);
    const list = await store.list();
    assert.equal(list[0].path, b);
    assert.equal(list[1].path, a);
    assert.equal(list[0].base, "b");
  });

  it("touch moves existing to front", async () => {
    await store.touch(a);
    const list = await store.list();
    assert.equal(list[0].path, a);
    assert.equal(list[1].path, b);
  });

  it("caps at max", async () => {
    const c = join(root, "c");
    const d = join(root, "d");
    await mkdir(c);
    await mkdir(d);
    // After a,b: touch a → [a,b]. Then c,d → [d,c,a] (b drops)
    await store.touch(c);
    await store.touch(d);
    const list = await store.list();
    assert.equal(list.length, 3);
    assert.equal(list[0].path, d);
    assert.ok(!list.some((r) => r.path === b), "oldest b should drop");
  });

  it("remove deletes entry", async () => {
    await store.touch(b);
    assert.equal(await store.remove(b), true);
    const list = await store.list();
    assert.ok(!list.some((r) => r.path === b));
  });

  it("pruneMissing drops gone dirs", async () => {
    const gone = join(root, "gone");
    await mkdir(gone);
    await store.touch(gone);
    await rm(gone, { recursive: true, force: true });
    const n = await store.pruneMissing();
    assert.ok(n >= 1);
    const list = await store.list();
    assert.ok(!list.some((r) => r.path === gone));
  });

  it("rejects invalid path on touch", async () => {
    const r = await store.touch(join(root, "missing-dir"));
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
  });
});
