import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspace,
  expandWorkspacePath,
  RecentsStore,
} from "../lib/workspace.mjs";

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

  it("rejects ~otheruser", async () => {
    const r = await resolveWorkspace("~other/proj");
    assert.equal(r.ok, false);
    assert.equal(r.code, "TILDE_USER");
  });
});

describe("expandWorkspacePath", () => {
  it("returns EMPTY for blank", () => {
    assert.equal(expandWorkspacePath("").ok, false);
  });
});

describe("RecentsStore", () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let file;
  /** @type {string} */
  let a;
  /** @type {string} */
  let b;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-rec-"));
    file = join(root, "recents.json");
    a = join(root, "a");
    b = join(root, "b");
    await mkdir(a);
    await mkdir(b);
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** @type {RecentsStore} */
  let store;

  beforeEach(() => {
    store = new RecentsStore({ filePath: file, max: 3 });
  });

  it("touch adds and MRU-orders", async () => {
    await store.touch(a);
    await store.touch(b);
    const list = await store.list({ hideMissing: false });
    assert.equal(list[0].path, b);
    assert.equal(list[1].path, a);
  });

  it("touch moves existing to front", async () => {
    await store.touch(a);
    await store.touch(b);
    await store.touch(a);
    const list = await store.list({ hideMissing: false });
    assert.equal(list[0].path, a);
  });

  it("caps at max", async () => {
    const c = join(root, "c");
    const d = join(root, "d");
    await mkdir(c).catch(() => {});
    await mkdir(d).catch(() => {});
    await store.touch(a);
    await store.touch(b);
    await store.touch(c);
    await store.touch(d);
    const list = await store.list({ hideMissing: false });
    assert.equal(list.length, 3);
    assert.equal(list[0].path, d);
    assert.ok(!list.some((r) => r.path === a));
  });

  it("remove deletes entry", async () => {
    await store.touch(a);
    await store.touch(b);
    assert.equal(await store.remove(b), true);
    const list = await store.list({ hideMissing: false });
    assert.ok(!list.some((r) => r.path === b));
  });

  it("remove empty path is a no-op", async () => {
    await store.touch(a);
    assert.equal(await store.remove(""), false);
    assert.equal(await store.remove("   "), false);
    const list = await store.list({ hideMissing: false });
    assert.ok(list.some((r) => r.path === a));
  });

  it("list hides missing without rewriting by default", async () => {
    const gone = join(root, "gone-hide");
    await mkdir(gone);
    await store.touch(gone);
    await rm(gone, { recursive: true, force: true });
    const visible = await store.list({ hideMissing: true });
    assert.ok(!visible.some((r) => r.path === gone));
    // Still on disk until prune
    const raw = await store.list({ hideMissing: false });
    assert.ok(raw.some((r) => r.path === gone));
  });

  it("pruneMissing drops gone dirs", async () => {
    const gone = join(root, "gone-prune");
    await mkdir(gone);
    await store.touch(gone);
    await rm(gone, { recursive: true, force: true });
    const n = await store.pruneMissing();
    assert.ok(n >= 1);
    const list = await store.list({ hideMissing: false });
    assert.ok(!list.some((r) => r.path === gone));
  });

  it("rejects invalid path on touch", async () => {
    const r = await store.touch(join(root, "missing-dir"));
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
  });

  it("serializes concurrent touch without losing entries", async () => {
    const dirs = [];
    for (let i = 0; i < 5; i++) {
      const p = join(root, `conc-${i}`);
      await mkdir(p).catch(() => {});
      dirs.push(p);
    }
    await Promise.all(dirs.map((p) => store.touch(p)));
    const list = await store.list({ hideMissing: false });
    // max 3 — should have 3 of the 5 without corruption
    assert.equal(list.length, 3);
    assert.ok(list.every((r) => r.path && r.base));
  });
});
