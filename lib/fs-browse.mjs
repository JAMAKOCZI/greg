/**
 * Read-only workspace file browsing (tree + text preview).
 * Paths are always resolved under a workspace root — no escape.
 */
import {
  access,
  constants as fsConstants,
  mkdir,
  open,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, platform as osPlatform } from "node:os";
import { expandWorkspacePath } from "./workspace.mjs";

/** Default dirs never listed / not recursed into. */
export const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".cache",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  "target", // rust
  "graphify-out", // maintainer tooling, not product
]);

export const DEFAULT_MAX_DEPTH = 2;
/** Hard cap for client-supplied depth (API / listTree). */
export const MAX_TREE_DEPTH = 3;
export const DEFAULT_MAX_ENTRIES = 400;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024; // 512 KiB

/**
 * Map fs-browse error codes to HTTP status (shared by /api/fs/*).
 * @param {string} [code]
 * @returns {number}
 */
export function fsBrowseHttpStatus(code) {
  switch (code) {
    case "OUTSIDE_ROOT":
    case "EACCES":
    case "ROOT_FORBIDDEN":
      return 403;
    case "NOT_FOUND":
    case "ROOT_NOT_FOUND":
      return 404;
    case "BINARY":
      return 415;
    default:
      return 400;
  }
}

/**
 * @param {string} rootAbs canonical absolute root
 * @param {string} candidateAbs absolute path (may not exist)
 * @returns {boolean}
 */
export function isPathInsideRoot(rootAbs, candidateAbs) {
  const root = rootAbs.endsWith(sep) ? rootAbs.slice(0, -1) : rootAbs;
  const cand = candidateAbs;
  if (cand === root) return true;
  const prefix = root + sep;
  return cand.startsWith(prefix);
}

/**
 * Resolve a user path relative to (or absolute under) workspace root.
 * Root accepts `~` / `~/…` (same as workspace helpers). Uses realpath when
 * the target exists so symlink escapes are rejected.
 *
 * @param {string} rootInput workspace root
 * @param {string} [relOrAbs] path under root (default root itself)
 * @returns {Promise<
 *   | { ok: true, root: string, abs: string, rel: string, exists: boolean }
 *   | { ok: false, error: string, code: string }
 * >}
 */
export async function resolveUnderRoot(rootInput, relOrAbs = "") {
  const rootRaw = String(rootInput ?? "").trim();
  if (!rootRaw) {
    return { ok: false, error: "Workspace root is empty", code: "EMPTY_ROOT" };
  }

  // Align with resolveWorkspace: expand ~ / ~/… before resolve
  const expandedRoot = expandWorkspacePath(rootRaw);
  if (!expandedRoot.ok) {
    return {
      ok: false,
      error: expandedRoot.error,
      code:
        expandedRoot.code === "EMPTY" ? "EMPTY_ROOT" : expandedRoot.code,
    };
  }

  let rootAbs = expandedRoot.path;
  // Browsing filesystem root would make every path "inside" — reject
  if (rootAbs === "/" || rootAbs === "\\") {
    return {
      ok: false,
      error: "Workspace root cannot be filesystem root (/)",
      code: "ROOT_FORBIDDEN",
    };
  }
  try {
    const st = await stat(rootAbs);
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: `Workspace root is not a directory: ${rootAbs}`,
        code: "ROOT_NOT_DIR",
      };
    }
    await access(rootAbs, fsConstants.R_OK | fsConstants.X_OK);
    try {
      rootAbs = await realpath(rootAbs);
    } catch {
      /* keep resolved path */
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        error: `Workspace root does not exist: ${rootAbs}`,
        code: "ROOT_NOT_FOUND",
      };
    }
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${rootAbs}`,
        code: "EACCES",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "ROOT_STAT_FAILED",
    };
  }

  const raw = String(relOrAbs ?? "").trim();
  let candidate;
  if (!raw || raw === "." || raw === "./") {
    candidate = rootAbs;
  } else if (isAbsolute(raw)) {
    candidate = resolve(raw);
  } else {
    candidate = resolve(rootAbs, raw);
  }

  // Lexical containment first (cheap reject for .. escape)
  if (!isPathInsideRoot(rootAbs, candidate)) {
    return {
      ok: false,
      error: "Path is outside workspace root",
      code: "OUTSIDE_ROOT",
    };
  }

  let finalAbs = candidate;
  let exists = false;
  try {
    finalAbs = await realpath(candidate);
    exists = true;
  } catch (err) {
    if (err?.code === "ENOENT") {
      finalAbs = candidate;
      exists = false;
    } else if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${candidate}`,
        code: "EACCES",
      };
    } else {
      return {
        ok: false,
        error: err?.message || String(err),
        code: err?.code || "RESOLVE_FAILED",
      };
    }
  }

  if (!isPathInsideRoot(rootAbs, finalAbs)) {
    return {
      ok: false,
      error: "Path is outside workspace root",
      code: "OUTSIDE_ROOT",
    };
  }

  const rel =
    finalAbs === rootAbs
      ? ""
      : relative(rootAbs, finalAbs).split("\\").join("/");

  return { ok: true, root: rootAbs, abs: finalAbs, rel, exists };
}

/**
 * @param {string} name
 * @param {Set<string>} ignore
 */
function isIgnoredName(name, ignore) {
  return ignore.has(name);
}

/**
 * List a single directory (non-recursive).
 * Omits ignore-listed names and entries whose realpath escapes rootAbs.
 *
 * @param {string} dirAbs
 * @param {{
 *   ignore?: Set<string>,
 *   maxEntries?: number,
 *   rootAbs?: string,
 * }} [opts]
 * @returns {Promise<{
 *   entries: { name: string, type: "file"|"dir"|"other", size?: number }[],
 *   truncated: boolean,
 * }>}
 */
async function listDirEntries(dirAbs, opts = {}) {
  const ignore = opts.ignore || DEFAULT_IGNORE_DIRS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const rootAbs = opts.rootAbs;
  let names;
  try {
    names = await readdir(dirAbs);
  } catch (err) {
    if (err?.code === "EACCES") {
      const e = new Error(`Permission denied: ${dirAbs}`);
      // @ts-ignore
      e.code = "EACCES";
      throw e;
    }
    throw err;
  }

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  /** @type {{ name: string, type: "file"|"dir"|"other", size?: number }[]} */
  const out = [];
  let truncated = false;

  for (const name of names) {
    if (name === "." || name === "..") continue;
    if (isIgnoredName(name, ignore)) continue;

    if (out.length >= maxEntries) {
      truncated = true;
      break;
    }

    const full = join(dirAbs, name);
    try {
      const st = await stat(full);
      // Reject symlink escapes (and any path whose realpath leaves the root)
      if (rootAbs) {
        try {
          const real = await realpath(full);
          if (!isPathInsideRoot(rootAbs, real)) continue;
        } catch {
          continue;
        }
      }

      if (st.isDirectory()) {
        out.push({ name, type: "dir" });
      } else if (st.isFile()) {
        out.push({ name, type: "file", size: st.size });
      } else {
        out.push({ name, type: "other" });
      }
    } catch {
      /* skip unreadable entries */
    }
  }

  out.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { entries: out, truncated };
}

/**
 * @typedef {{
 *   name: string,
 *   type: "file"|"dir"|"other",
 *   path: string,
 *   size?: number,
 *   children?: TreeNode[],
 *   inaccessible?: boolean,
 * }} TreeNode
 */

/**
 * Build a depth-limited tree under workspace root.
 *
 * @param {string} rootInput
 * @param {string} [pathInput] relative or absolute under root
 * @param {{
 *   depth?: number,
 *   maxEntries?: number,
 *   ignore?: Set<string>|string[],
 * }} [opts]
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       root: string,
 *       path: string,
 *       abs: string,
 *       truncated: boolean,
 *       entries: TreeNode[],
 *     }
 *   | { ok: false, error: string, code: string }
 * >}
 */
export async function listTree(rootInput, pathInput = "", opts = {}) {
  const depthRaw = opts.depth;
  const depth = Number.isFinite(Number(depthRaw))
    ? Math.max(0, Math.min(MAX_TREE_DEPTH, Number(depthRaw)))
    : DEFAULT_MAX_DEPTH;
  const maxEntriesRaw = opts.maxEntries;
  const maxEntries = Number.isFinite(Number(maxEntriesRaw))
    ? Math.max(1, Math.min(2000, Number(maxEntriesRaw)))
    : DEFAULT_MAX_ENTRIES;
  const ignore = toIgnoreSet(opts.ignore);

  const resolved = await resolveUnderRoot(rootInput, pathInput);
  if (!resolved.ok) return resolved;

  let st;
  try {
    st = await stat(resolved.abs);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        error: `Path does not exist: ${resolved.rel || resolved.abs}`,
        code: "NOT_FOUND",
      };
    }
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${resolved.rel || resolved.abs}`,
        code: "EACCES",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "STAT_FAILED",
    };
  }

  if (!st.isDirectory()) {
    return {
      ok: false,
      error: "Path is not a directory",
      code: "NOT_DIR",
    };
  }

  let anyTruncated = false;

  /**
   * @param {string} dirAbs
   * @param {string} relPrefix
   * @param {number} remaining
   * @returns {Promise<TreeNode[]>}
   */
  async function walk(dirAbs, relPrefix, remaining) {
    let listed;
    try {
      listed = await listDirEntries(dirAbs, {
        ignore,
        maxEntries,
        rootAbs: resolved.root,
      });
    } catch (err) {
      if (err?.code === "EACCES") {
        const e = new Error(`Permission denied: ${dirAbs}`);
        // @ts-ignore
        e.code = "EACCES";
        throw e;
      }
      throw err;
    }
    if (listed.truncated) anyTruncated = true;

    /** @type {TreeNode[]} */
    const nodes = [];
    for (const e of listed.entries) {
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
      /** @type {TreeNode} */
      const node = {
        name: e.name,
        type: e.type,
        path: rel,
      };
      if (e.type === "file" && e.size != null) node.size = e.size;

      if (e.type === "dir" && remaining > 0) {
        const childAbs = join(dirAbs, e.name);
        try {
          const realChild = await realpath(childAbs);
          if (!isPathInsideRoot(resolved.root, realChild)) {
            // Should already be filtered by listDirEntries; skip if race
            continue;
          }
          try {
            node.children = await walk(realChild, rel, remaining - 1);
          } catch (walkErr) {
            if (walkErr?.code === "EACCES") {
              node.children = [];
              node.inaccessible = true;
            } else {
              node.children = [];
            }
          }
        } catch {
          node.children = [];
        }
      }
      nodes.push(node);
    }
    return nodes;
  }

  try {
    const entries = await walk(resolved.abs, resolved.rel, depth);
    return {
      ok: true,
      root: resolved.root,
      path: resolved.rel,
      abs: resolved.abs,
      truncated: anyTruncated,
      entries,
    };
  } catch (err) {
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: err.message || `Permission denied: ${resolved.rel || resolved.abs}`,
        code: "EACCES",
      };
    }
    throw err;
  }
}

/**
 * Read a text file under workspace root (size-capped).
 * Re-checks realpath and prefers O_NOFOLLOW to reduce TOCTOU symlink swaps.
 *
 * @param {string} rootInput
 * @param {string} pathInput
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       root: string,
 *       path: string,
 *       abs: string,
 *       size: number,
 *       truncated: boolean,
 *       binary: false,
 *       content: string,
 *     }
 *   | { ok: false, error: string, code: string }
 * >}
 */
export async function readWorkspaceFile(rootInput, pathInput, opts = {}) {
  const maxBytesRaw = opts.maxBytes;
  const maxBytes = Number.isFinite(Number(maxBytesRaw))
    ? Math.max(1, Math.min(5 * 1024 * 1024, Number(maxBytesRaw)))
    : DEFAULT_MAX_FILE_BYTES;

  if (pathInput == null || String(pathInput).trim() === "") {
    return { ok: false, error: "Missing file path", code: "EMPTY_PATH" };
  }

  const resolved = await resolveUnderRoot(rootInput, pathInput);
  if (!resolved.ok) return resolved;
  if (!resolved.exists) {
    return {
      ok: false,
      error: `File not found: ${resolved.rel || pathInput}`,
      code: "NOT_FOUND",
    };
  }

  // Re-canonicalize immediately before open (TOCTOU window shrink)
  let openPath = resolved.abs;
  try {
    openPath = await realpath(resolved.abs);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        error: `File not found: ${resolved.rel || pathInput}`,
        code: "NOT_FOUND",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "RESOLVE_FAILED",
    };
  }
  if (!isPathInsideRoot(resolved.root, openPath)) {
    return {
      ok: false,
      error: "Path is outside workspace root",
      code: "OUTSIDE_ROOT",
    };
  }

  /** @type {import('node:fs/promises').FileHandle} */
  let fh;
  try {
    // Prefer not following a last-component symlink swap after realpath
    const flags =
      typeof fsConstants.O_NOFOLLOW === "number"
        ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
        : "r";
    fh = await open(openPath, flags);
  } catch (err) {
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${resolved.rel}`,
        code: "EACCES",
      };
    }
    if (err?.code === "ELOOP" || err?.code === "EINVAL") {
      // Symlink where we expected a regular path after realpath
      return {
        ok: false,
        error: "Path is outside workspace root or not a regular file",
        code: "OUTSIDE_ROOT",
      };
    }
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        error: `File not found: ${resolved.rel || pathInput}`,
        code: "NOT_FOUND",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "READ_FAILED",
    };
  }

  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      return {
        ok: false,
        error: "Path is not a regular file",
        code: "NOT_FILE",
      };
    }

    const size = st.size;
    const toRead = Math.min(size, maxBytes);
    let buf = Buffer.alloc(toRead);
    if (toRead > 0) {
      const { bytesRead } = await fh.read(buf, 0, toRead, 0);
      buf = buf.subarray(0, bytesRead);
    } else {
      buf = Buffer.alloc(0);
    }

    if (looksBinary(buf)) {
      return {
        ok: false,
        error: "Binary file (preview supports text only)",
        code: "BINARY",
      };
    }

    const truncated = size > maxBytes;
    const content = buf.toString("utf8");
    const rel =
      openPath === resolved.root
        ? ""
        : relative(resolved.root, openPath).split("\\").join("/");
    return {
      ok: true,
      root: resolved.root,
      path: rel || resolved.rel,
      abs: openPath,
      size,
      truncated,
      binary: false,
      content,
    };
  } catch (err) {
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${resolved.rel}`,
        code: "EACCES",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "READ_FAILED",
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Split an absolute path into clickable breadcrumb segments.
 * @param {string} absPath
 * @returns {{ label: string, path: string }[]}
 */
export function pathBreadcrumbs(absPath) {
  const raw = String(absPath ?? "").trim();
  if (!raw) return [];

  // Windows drive paths (also when Greg runs on Linux but shows a remote-style path)
  const win = raw.match(/^([A-Za-z]:)([\\/])?(.*)$/);
  if (win) {
    const driveRoot = win[1] + "\\";
    const rest = (win[3] || "").split(/[\\/]/).filter(Boolean);
    /** @type {{ label: string, path: string }[]} */
    const crumbs = [{ label: win[1], path: driveRoot }];
    let acc = driveRoot;
    for (const part of rest) {
      acc = acc.endsWith("\\") ? acc + part : acc + "\\" + part;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }

  if (raw === "/" || raw === "\\") {
    return [{ label: "/", path: "/" }];
  }

  const parts = raw.split("/").filter(Boolean);
  /** @type {{ label: string, path: string }[]} */
  const crumbs = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/**
 * Roots / drives for the folder picker “switch drive” control.
 * @returns {Promise<{
 *   ok: true,
 *   platform: string,
 *   home: string,
 *   roots: { id: string, path: string, label: string }[],
 * }>}
 */
export async function listFilesystemRoots() {
  const home = homedir();
  const plat = osPlatform();
  /** @type {{ id: string, path: string, label: string }[]} */
  const roots = [{ id: "home", path: home, label: "Home" }];

  if (plat === "win32") {
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const p = `${letter}:\\`;
      try {
        await access(p, fsConstants.R_OK);
        roots.push({ id: letter, path: p, label: `${letter}:` });
      } catch {
        /* drive not present */
      }
    }
  } else {
    roots.push({ id: "root", path: "/", label: "Computer (/)" });
    for (const p of ["/mnt", "/media", "/run/media", "/Volumes"]) {
      try {
        const st = await stat(p);
        if (st.isDirectory()) {
          await access(p, fsConstants.R_OK | fsConstants.X_OK);
          roots.push({ id: p, path: p, label: p });
        }
      } catch {
        /* skip */
      }
    }
  }

  return { ok: true, platform: plat, home, roots };
}

/**
 * Create a subdirectory under an existing directory (folder picker).
 * @param {string} parentInput
 * @param {string} nameInput
 * @returns {Promise<
 *   | { ok: true, path: string, parent: string }
 *   | { ok: false, error: string, code: string }
 * >}
 */
export async function createDirectory(parentInput, nameInput) {
  const name = String(nameInput ?? "").trim();
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[\\/]/.test(name) ||
    name.includes("\0") ||
    name.length > 200
  ) {
    return {
      ok: false,
      error: "Invalid folder name (no slashes; max 200 chars)",
      code: "INVALID_NAME",
    };
  }

  const parentList = await listDirectories(parentInput);
  if (!parentList.ok) return parentList;

  const parent = parentList.path;
  if (parent === "/" || parent === "\\") {
    // Creating directly under filesystem root is allowed on Unix, but rare;
    // still permit if user navigated there.
  }

  const target = join(parent, name);
  try {
    await mkdir(target, { recursive: false, mode: 0o755 });
    let finalPath = target;
    try {
      finalPath = await realpath(target);
    } catch {
      /* keep */
    }
    return { ok: true, path: finalPath, parent };
  } catch (err) {
    if (err?.code === "EEXIST") {
      return {
        ok: false,
        error: `Already exists: ${name}`,
        code: "EEXIST",
      };
    }
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied creating folder in ${parent}`,
        code: "EACCES",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "MKDIR_FAILED",
    };
  }
}

/**
 * List subdirectories for the workspace folder picker (not confined to a project root).
 * May browse `/` (Computer) for drive/root selection; selecting `/` as workspace is blocked in the UI.
 *
 * @param {string} [pathInput] absolute, relative, or `~` (default: home)
 * @param {{ maxEntries?: number, ignore?: Set<string>|string[] }} [opts]
 * @returns {Promise<
 *   | {
 *       ok: true,
 *       path: string,
 *       parent: string|null,
 *       home: string,
 *       breadcrumbs: { label: string, path: string }[],
 *       truncated: boolean,
 *       entries: { name: string, path: string, type: "dir" }[],
 *     }
 *   | { ok: false, error: string, code: string }
 * >}
 */
export async function listDirectories(pathInput, opts = {}) {
  const maxEntries = Number.isFinite(Number(opts.maxEntries))
    ? Math.max(1, Math.min(2000, Number(opts.maxEntries)))
    : DEFAULT_MAX_ENTRIES;
  const ignore = opts.ignore
    ? opts.ignore instanceof Set
      ? opts.ignore
      : new Set(opts.ignore)
    : DEFAULT_IGNORE_DIRS;

  const raw = String(pathInput ?? "").trim() || "~";
  const expanded = expandWorkspacePath(raw);
  if (!expanded.ok) {
    return {
      ok: false,
      error: expanded.error,
      code: expanded.code === "EMPTY" ? "EMPTY_PATH" : expanded.code,
    };
  }

  let abs = expanded.path;

  try {
    const st = await stat(abs);
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: `Not a directory: ${abs}`,
        code: "NOT_DIR",
      };
    }
    await access(abs, fsConstants.R_OK | fsConstants.X_OK);
    // realpath of "/" stays "/"; for other paths canonicalize
    try {
      abs = await realpath(abs);
    } catch {
      /* keep */
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        ok: false,
        error: `Path does not exist: ${abs}`,
        code: "NOT_FOUND",
      };
    }
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${abs}`,
        code: "EACCES",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "STAT_FAILED",
    };
  }

  let names;
  try {
    names = await readdir(abs);
  } catch (err) {
    if (err?.code === "EACCES") {
      return {
        ok: false,
        error: `Permission denied: ${abs}`,
        code: "EACCES",
      };
    }
    return {
      ok: false,
      error: err?.message || String(err),
      code: err?.code || "READ_FAILED",
    };
  }

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  /** @type {{ name: string, path: string, type: "dir" }[]} */
  const entries = [];
  let truncated = false;

  for (const name of names) {
    if (name === "." || name === "..") continue;
    // At filesystem root, still skip heavy/system dirs we never want as projects
    if (ignore.has(name)) continue;
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const full = abs === "/" ? `/${name}` : join(abs, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      let real = full;
      try {
        real = await realpath(full);
      } catch {
        continue;
      }
      entries.push({ name, path: real, type: "dir" });
    } catch {
      /* skip unreadable */
    }
  }

  const parentRaw = dirname(abs);
  // At "/", no parent; otherwise parent may be "/"
  let parent = null;
  if (abs !== "/" && abs !== "\\") {
    if (parentRaw && parentRaw !== abs) parent = parentRaw;
  }

  return {
    ok: true,
    path: abs,
    parent,
    home: homedir(),
    breadcrumbs: pathBreadcrumbs(abs),
    truncated,
    entries,
  };
}

/**
 * @param {Buffer} buf
 */
export function looksBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return true;
  let weird = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) weird++;
  }
  return weird / sample.length > 0.05;
}

/**
 * @param {Set<string>|string[]|undefined} ignore
 * @returns {Set<string>}
 */
function toIgnoreSet(ignore) {
  if (!ignore) return DEFAULT_IGNORE_DIRS;
  if (ignore instanceof Set) return ignore;
  return new Set(ignore);
}
