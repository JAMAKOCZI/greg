/**
 * Read-only workspace file browsing (tree + text preview).
 * Paths are always resolved under a workspace root — no escape.
 */
import {
  access,
  constants as fsConstants,
  open,
  readdir,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
export const DEFAULT_MAX_ENTRIES = 400;
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024; // 512 KiB

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
 * Uses realpath when the target exists so symlink escapes are rejected.
 *
 * @param {string} rootInput workspace root
 * @param {string} [relOrAbs] path under root (default root itself)
 * @returns {Promise<
 *   | { ok: true, root: string, abs: string, rel: string }
 *   | { ok: false, error: string, code: string }
 * >}
 */
export async function resolveUnderRoot(rootInput, relOrAbs = "") {
  const rootRaw = String(rootInput ?? "").trim();
  if (!rootRaw) {
    return { ok: false, error: "Workspace root is empty", code: "EMPTY_ROOT" };
  }

  let rootAbs = resolve(rootRaw);
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
    // Reject absolute-looking Windows paths on unix via resolve
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
      // Parent may exist; still enforce lexical under root
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
    finalAbs === rootAbs ? "" : relative(rootAbs, finalAbs).split("\\").join("/");

  // If target does not exist, still return for callers that need to distinguish
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
 * @param {string} dirAbs
 * @param {{ ignore?: Set<string>, maxEntries?: number }} [opts]
 * @returns {Promise<{ name: string, type: "file"|"dir"|"other", size?: number }[]>}
 */
async function listDirEntries(dirAbs, opts = {}) {
  const ignore = opts.ignore || DEFAULT_IGNORE_DIRS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let names;
  try {
    names = await readdir(dirAbs);
  } catch (err) {
    if (err?.code === "EACCES") {
      const e = new Error(`Permission denied: ${dirAbs}`);
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

  // dirs first, then files
  out.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  return { entries: out, truncated };
}

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
 *
 * @typedef {{
 *   name: string,
 *   type: "file"|"dir"|"other",
 *   path: string,
 *   size?: number,
 *   children?: TreeNode[],
 *   truncated?: boolean,
 * }} TreeNode
 */
export async function listTree(rootInput, pathInput = "", opts = {}) {
  const depthRaw = opts.depth;
  const depth = Number.isFinite(Number(depthRaw))
    ? Math.max(0, Math.min(8, Number(depthRaw)))
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
    const { entries, truncated } = await listDirEntries(dirAbs, {
      ignore,
      maxEntries,
    });
    if (truncated) anyTruncated = true;

    /** @type {TreeNode[]} */
    const nodes = [];
    for (const e of entries) {
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
        // Symlink dirs: only descend if still under root after realpath
        try {
          const realChild = await realpath(childAbs);
          if (!isPathInsideRoot(resolved.root, realChild)) {
            nodes.push(node);
            continue;
          }
          const kids = await walk(realChild, rel, remaining - 1);
          node.children = kids;
        } catch {
          node.children = [];
        }
      }
      nodes.push(node);
    }
    return nodes;
  }

  const entries = await walk(resolved.abs, resolved.rel, depth);
  return {
    ok: true,
    root: resolved.root,
    path: resolved.rel,
    abs: resolved.abs,
    truncated: anyTruncated,
    entries,
  };
}

/**
 * Read a text file under workspace root (size-capped).
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
  const maxBytes = Math.max(
    1,
    Math.min(
      5 * 1024 * 1024,
      Number(opts.maxBytes ?? DEFAULT_MAX_FILE_BYTES) || DEFAULT_MAX_FILE_BYTES,
    ),
  );

  if (pathInput == null || String(pathInput).trim() === "") {
    return { ok: false, error: "Missing file path", code: "EMPTY_PATH" };
  }

  const resolved = await resolveUnderRoot(rootInput, pathInput);
  if (!resolved.ok) return resolved;

  let st;
  try {
    st = await stat(resolved.abs);
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
      code: err?.code || "STAT_FAILED",
    };
  }

  if (!st.isFile()) {
    return {
      ok: false,
      error: "Path is not a regular file",
      code: "NOT_FILE",
    };
  }

  const size = st.size;
  let buf;
  try {
    await access(resolved.abs, fsConstants.R_OK);
    if (size > maxBytes) {
      // Read only the cap
      const fh = await open(resolved.abs, "r");
      try {
        buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
        buf = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } else {
      buf = await readFile(resolved.abs);
    }
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
  return {
    ok: true,
    root: resolved.root,
    path: resolved.rel,
    abs: resolved.abs,
    size,
    truncated,
    binary: false,
    content,
  };
}

/**
 * @param {Buffer} buf
 */
export function looksBinary(buf) {
  if (!buf || buf.length === 0) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  // NUL byte is a strong binary signal
  if (sample.includes(0)) return true;
  // High ratio of non-text control chars (exclude tab/lf/cr)
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

