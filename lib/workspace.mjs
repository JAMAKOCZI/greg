/**
 * Workspace path validation and recent-workspaces store (~/.greg/recents.json).
 */
import {
  access,
  constants as fsConstants,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";

const DEFAULT_MAX_RECENTS = 20;

/**
 * @param {string} [path]
 * @returns {string}
 */
export function defaultRecentsPath(path) {
  if (path) return path;
  return resolve(homedir(), ".greg", "recents.json");
}

/**
 * Expand ~ and resolve to an absolute path (no existence check).
 * @param {string} input
 * @param {string} [base]
 * @returns {{ ok: true, path: string } | { ok: false, error: string, code: string }}
 */
export function expandWorkspacePath(input, base = process.cwd()) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    return { ok: false, error: "Workspace path is empty", code: "EMPTY" };
  }

  // ~user is not supported (personal tool)
  if (/^~[^/\\]/.test(raw)) {
    return {
      ok: false,
      error: "Only ~ and ~/… are supported (not ~otheruser)",
      code: "TILDE_USER",
    };
  }

  let expanded = raw;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = resolve(homedir(), expanded.slice(2));
  }

  const abs = isAbsolute(expanded)
    ? resolve(expanded)
    : resolve(base, expanded);
  return { ok: true, path: abs };
}

/**
 * Resolve and validate a workspace directory path.
 *
 * @param {string} input
 * @param {{
 *   mustExist?: boolean,
 *   requireDirectory?: boolean,
 *   base?: string,
 *   useRealpath?: boolean,
 * }} [opts]
 *   mustExist default true — reject missing paths
 *   requireDirectory default true
 *   useRealpath default true when mustExist — canonicalize symlinks for recents keys
 *   base — resolve relative paths against this (default process.cwd())
 * @returns {Promise<{ ok: true, path: string, base: string } | { ok: false, error: string, code: string }>}
 */
export async function resolveWorkspace(input, opts = {}) {
  const mustExist = opts.mustExist !== false;
  const requireDirectory = opts.requireDirectory !== false;
  const useRealpath = opts.useRealpath !== false && mustExist;
  const base = opts.base || process.cwd();

  const expanded = expandWorkspacePath(input, base);
  if (!expanded.ok) return expanded;
  const abs = expanded.path;

  if (!mustExist) {
    return { ok: true, path: abs, base: basename(abs) || abs };
  }

  try {
    const st = await stat(abs);
    if (requireDirectory && !st.isDirectory()) {
      return {
        ok: false,
        error: `Not a directory: ${abs}`,
        code: "NOT_DIR",
      };
    }
    // cwd needs search/execute as well as read
    const mode = requireDirectory
      ? fsConstants.R_OK | fsConstants.X_OK
      : fsConstants.R_OK;
    await access(abs, mode);

    let finalPath = abs;
    if (useRealpath) {
      try {
        finalPath = await realpath(abs);
      } catch {
        finalPath = abs;
      }
    }
    return { ok: true, path: finalPath, base: basename(finalPath) || finalPath };
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
}

/**
 * Recent workspaces store (MRU list on disk).
 */
export class RecentsStore {
  /**
   * @param {{ filePath?: string, max?: number }} [opts]
   */
  constructor(opts = {}) {
    this.filePath = defaultRecentsPath(opts.filePath);
    this.max = Math.max(1, Number(opts.max) || DEFAULT_MAX_RECENTS);
    /** @type {Promise<unknown>} */
    this._lock = Promise.resolve();
  }

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withLock(fn) {
    const prev = this._lock;
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    this._lock = prev.then(() => gate);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * List recents. By default filters missing dirs **in the response only**
   * (does not rewrite the file). Pass `{ prune: true }` to drop them on disk.
   *
   * @param {{ prune?: boolean, hideMissing?: boolean }} [opts]
   * @returns {Promise<{ path: string, base: string, lastUsedAt: number }[]>}
   */
  async list(opts = {}) {
    const hideMissing = opts.hideMissing !== false;
    return this.#withLock(async () => {
      const data = await this.#read();
      if (opts.prune) {
        const removed = await this.#filterExisting(data);
        if (removed > 0) await this.#write(data);
      }
      if (!hideMissing) return data.recents;
      const visible = [];
      for (const r of data.recents) {
        if (await this.#isUsableDir(r.path)) visible.push(r);
      }
      return visible;
    });
  }

  /**
   * Move path to front (or insert). Validates existence by default.
   * @param {string} inputPath
   * @param {{ skipValidate?: boolean }} [opts]
   * @returns {Promise<{ ok: true, path: string, recents: object[] } | { ok: false, error: string, code: string }>}
   */
  async touch(inputPath, opts = {}) {
    return this.#withLock(async () => {
      let abs;
      let baseName;

      if (!opts.skipValidate) {
        const resolved = await resolveWorkspace(inputPath);
        if (!resolved.ok) return resolved;
        abs = resolved.path;
        baseName = resolved.base;
      } else {
        const expanded = expandWorkspacePath(inputPath);
        if (!expanded.ok) return expanded;
        abs = expanded.path;
        // Prefer realpath when path exists
        try {
          const st = await stat(abs);
          if (st.isDirectory()) {
            try {
              abs = await realpath(abs);
            } catch {
              /* keep abs */
            }
          }
        } catch {
          /* keep lexical path */
        }
        baseName = basename(abs) || abs;
      }

      const data = await this.#read();
      const now = Date.now();
      const filtered = data.recents.filter((r) => r.path !== abs);
      filtered.unshift({ path: abs, base: baseName, lastUsedAt: now });
      data.recents = filtered.slice(0, this.max);
      await this.#write(data);
      return { ok: true, path: abs, recents: data.recents };
    });
  }

  /**
   * @param {string} path
   * @returns {Promise<boolean>} true if removed
   */
  async remove(path) {
    return this.#withLock(async () => {
      const raw = String(path ?? "").trim();
      if (!raw) return false;

      const expanded = expandWorkspacePath(raw);
      if (!expanded.ok) return false;
      let abs = expanded.path;
      try {
        abs = await realpath(abs);
      } catch {
        /* compare lexical */
      }

      const data = await this.#read();
      const before = data.recents.length;
      data.recents = data.recents.filter((r) => r.path !== abs && r.path !== expanded.path);
      if (data.recents.length === before) return false;
      await this.#write(data);
      return true;
    });
  }

  /**
   * Drop entries whose paths no longer exist (writes disk).
   * @returns {Promise<number>} number removed
   */
  async pruneMissing() {
    return this.#withLock(async () => {
      const data = await this.#read();
      const removed = await this.#filterExisting(data);
      if (removed > 0) await this.#write(data);
      return removed;
    });
  }

  /**
   * @param {{ recents: { path: string }[] }} data
   * @returns {Promise<number>}
   */
  async #filterExisting(data) {
    const kept = [];
    let removed = 0;
    for (const r of data.recents) {
      if (await this.#isUsableDir(r.path)) kept.push(r);
      else removed++;
    }
    data.recents = kept;
    return removed;
  }

  /**
   * @param {string} p
   */
  async #isUsableDir(p) {
    try {
      const st = await stat(p);
      if (!st.isDirectory()) return false;
      await access(p, fsConstants.R_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async #read() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const doc = JSON.parse(raw);
      const list = Array.isArray(doc?.recents) ? doc.recents : [];
      return {
        recents: list
          .filter((r) => r && typeof r.path === "string" && r.path.trim())
          .map((r) => ({
            path: String(r.path),
            base: String(r.base || basename(r.path) || r.path),
            lastUsedAt: Number(r.lastUsedAt) || 0,
          })),
      };
    } catch (err) {
      if (err?.code === "ENOENT") return { recents: [] };
      if (err instanceof SyntaxError) return { recents: [] };
      throw err;
    }
  }

  /**
   * @param {{ recents: object[] }} data
   */
  async #write(data) {
    const dir = resolve(this.filePath, "..");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ recents: data.recents }, null, 2) + "\n";
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fh = await open(tmp, "w", 0o600);
      try {
        await fh.writeFile(payload, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.filePath);
    } catch (err) {
      try {
        await rm(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}
