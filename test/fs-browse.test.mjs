import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  symlink,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { tmpdir, platform, homedir } from "node:os";
import { join } from "node:path";
import {
  isPathInsideRoot,
  resolveUnderRoot,
  listTree,
  readWorkspaceFile,
  looksBinary,
  fsBrowseHttpStatus,
  DEFAULT_IGNORE_DIRS,
  MAX_TREE_DEPTH,
} from "../lib/fs-browse.mjs";

describe("isPathInsideRoot", () => {
  it("accepts root itself and children", () => {
    assert.equal(isPathInsideRoot("/proj", "/proj"), true);
    assert.equal(isPathInsideRoot("/proj", "/proj/a"), true);
    assert.equal(isPathInsideRoot("/proj", "/proj/a/b.txt"), true);
  });

  it("rejects sibling / prefix tricks", () => {
    assert.equal(isPathInsideRoot("/proj", "/proj-evil"), false);
    assert.equal(isPathInsideRoot("/proj", "/other"), false);
    assert.equal(isPathInsideRoot("/proj", "/"), false);
  });
});

describe("looksBinary", () => {
  it("treats plain text as text", () => {
    assert.equal(looksBinary(Buffer.from("hello\nworld\t!")), false);
  });

  it("detects NUL bytes", () => {
    assert.equal(looksBinary(Buffer.from([0x00, 0x01, 0x02])), true);
  });
});

describe("fsBrowseHttpStatus", () => {
  it("maps codes consistently for tree and file routes", () => {
    assert.equal(fsBrowseHttpStatus("OUTSIDE_ROOT"), 403);
    assert.equal(fsBrowseHttpStatus("EACCES"), 403);
    assert.equal(fsBrowseHttpStatus("NOT_FOUND"), 404);
    assert.equal(fsBrowseHttpStatus("ROOT_NOT_FOUND"), 404);
    assert.equal(fsBrowseHttpStatus("BINARY"), 415);
    assert.equal(fsBrowseHttpStatus("EMPTY_PATH"), 400);
    assert.equal(fsBrowseHttpStatus("NOT_FILE"), 400);
  });
});

describe("resolveUnderRoot / listTree / readWorkspaceFile", () => {
  /** @type {string} */
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "greg-fs-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "src", "nested"));
    await writeFile(join(root, "README.md"), "# hi\n");
    await writeFile(join(root, "src", "app.js"), "console.log(1);\n");
    await writeFile(join(root, "src", "nested", "deep.txt"), "deep\n");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "x");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves relative path under root", async () => {
    const r = await resolveUnderRoot(root, "src/app.js");
    assert.equal(r.ok, true);
    assert.equal(r.rel, "src/app.js");
    assert.equal(r.root, root);
    assert.equal(r.exists, true);
    assert.ok(r.abs.endsWith(join("src", "app.js")));
  });

  it("rejects empty root", async () => {
    const r = await resolveUnderRoot("  ", "a");
    assert.equal(r.ok, false);
    assert.equal(r.code, "EMPTY_ROOT");
  });

  it("rejects path traversal with ..", async () => {
    const r = await resolveUnderRoot(root, "../outside.txt");
    assert.equal(r.ok, false);
    assert.equal(r.code, "OUTSIDE_ROOT");
  });

  it("rejects nested .. traversal after normalize", async () => {
    const r = await resolveUnderRoot(root, "src/../../outside");
    assert.equal(r.ok, false);
    assert.equal(r.code, "OUTSIDE_ROOT");
  });

  it("rejects absolute path outside root", async () => {
    const r = await resolveUnderRoot(root, tmpdir());
    assert.equal(r.ok, false);
    assert.equal(r.code, "OUTSIDE_ROOT");
  });

  it("allows absolute path inside root", async () => {
    const r = await resolveUnderRoot(root, join(root, "README.md"));
    assert.equal(r.ok, true);
    assert.equal(r.rel, "README.md");
  });

  it("expands ~ as workspace root when it is a directory", async () => {
    const r = await resolveUnderRoot("~", "");
    assert.equal(r.ok, true);
    assert.equal(r.root, homedir());
  });

  it("lists tree and skips ignored dirs", async () => {
    const t = await listTree(root, "", { depth: 2 });
    assert.equal(t.ok, true);
    const names = t.entries.map((e) => e.name);
    assert.ok(names.includes("src"));
    assert.ok(names.includes("README.md"));
    assert.ok(!names.includes("node_modules"));
    assert.ok(!names.includes(".git"));
    assert.ok(DEFAULT_IGNORE_DIRS.has("node_modules"));

    const src = t.entries.find((e) => e.name === "src");
    assert.equal(src?.type, "dir");
    assert.ok(Array.isArray(src.children));
    assert.ok(src.children.some((c) => c.name === "app.js"));
  });

  it("respects depth 0 (no children expanded)", async () => {
    const t = await listTree(root, "", { depth: 0 });
    assert.equal(t.ok, true);
    const src = t.entries.find((e) => e.name === "src");
    assert.equal(src?.type, "dir");
    assert.equal(src.children, undefined);
  });

  it("clamps depth to MAX_TREE_DEPTH", async () => {
    assert.equal(MAX_TREE_DEPTH, 3);
    const t = await listTree(root, "", { depth: 99 });
    assert.equal(t.ok, true);
    // still returns a tree; clamp is internal (no throw)
  });

  it("lists a subdirectory only", async () => {
    const t = await listTree(root, "src", { depth: 1 });
    assert.equal(t.ok, true);
    assert.equal(t.path, "src");
    assert.ok(t.entries.some((e) => e.name === "app.js"));
    assert.ok(t.entries.some((e) => e.name === "nested"));
  });

  it("reads text file content", async () => {
    const f = await readWorkspaceFile(root, "src/app.js");
    assert.equal(f.ok, true);
    assert.equal(f.path, "src/app.js");
    assert.match(f.content, /console\.log/);
    assert.equal(f.truncated, false);
  });

  it("rejects binary preview", async () => {
    const f = await readWorkspaceFile(root, "binary.bin");
    assert.equal(f.ok, false);
    assert.equal(f.code, "BINARY");
  });

  it("rejects EMPTY_PATH and NOT_FILE", async () => {
    const empty = await readWorkspaceFile(root, "  ");
    assert.equal(empty.ok, false);
    assert.equal(empty.code, "EMPTY_PATH");

    const dir = await readWorkspaceFile(root, "src");
    assert.equal(dir.ok, false);
    assert.equal(dir.code, "NOT_FILE");
  });

  it("truncates large files", async () => {
    const big = join(root, "big.txt");
    await writeFile(big, "x".repeat(2000));
    const f = await readWorkspaceFile(root, "big.txt", { maxBytes: 100 });
    assert.equal(f.ok, true);
    assert.equal(f.truncated, true);
    assert.equal(f.content.length, 100);
    assert.equal(f.size, 2000);
  });

  it("rejects reading outside root", async () => {
    const f = await readWorkspaceFile(root, "../../etc/passwd");
    assert.equal(f.ok, false);
    assert.equal(f.code, "OUTSIDE_ROOT");
  });

  it("rejects symlink escape (dir link) via resolveUnderRoot", async () => {
    if (platform() === "win32") return;
    const outside = await mkdtemp(join(tmpdir(), "greg-fs-out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret\n");
      const link = join(root, "escape-link");
      try {
        await symlink(outside, link, "dir");
      } catch {
        return;
      }
      const r = await resolveUnderRoot(root, "escape-link/secret.txt");
      assert.equal(r.ok, false);
      assert.equal(r.code, "OUTSIDE_ROOT");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("omits outside symlink dirs from listTree", async () => {
    if (platform() === "win32") return;
    const outside = await mkdtemp(join(tmpdir(), "greg-fs-out2-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret\n");
      const link = join(root, "escape-dir");
      try {
        await symlink(outside, link, "dir");
      } catch {
        return;
      }
      const t = await listTree(root, "", { depth: 0 });
      assert.equal(t.ok, true);
      assert.ok(!t.entries.some((e) => e.name === "escape-dir"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects readWorkspaceFile on file symlink to outside", async () => {
    if (platform() === "win32") return;
    const outside = await mkdtemp(join(tmpdir(), "greg-fs-out3-"));
    try {
      const secret = join(outside, "secret.txt");
      await writeFile(secret, "top-secret\n");
      const link = join(root, "leak.txt");
      try {
        await symlink(secret, link);
      } catch {
        return;
      }
      const f = await readWorkspaceFile(root, "leak.txt");
      assert.equal(f.ok, false);
      assert.equal(f.code, "OUTSIDE_ROOT");
      // also must not appear in tree
      const t = await listTree(root, "", { depth: 0 });
      assert.ok(!t.entries.some((e) => e.name === "leak.txt"));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
