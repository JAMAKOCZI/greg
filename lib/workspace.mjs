/**
 * Workspace path validation and recent-workspaces store (~/.greg/recents.json).
 */
import {
  access,
  constants as fsConstants,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
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
 * Resolve and validate a workspace directory path.
 *
 * @param {string} input
 * @param {{
 *   mustExist?: boolean,
 *   requireDirectory?: boolean,
 *   base?: string,
 * }} [opts]
 *   mustExist default true — reject missing paths
 *   requireDirectory default true
 *   base — resolve relative paths against this (default process.cwd())
 * @returns {Promise<{ ok: true, path: string, base: string } | { ok: false, error: string, code: string }>}
 */
export async function resolveWorkspace(input, opts = {}) {
  const mustExist = opts.mustExist !== false;
  const requireDirectory = opts.requireDirectory !== false;
  const base = opts.base || process.cwd();

  const raw = String(input ?? "").trim();
  if (!raw) {
    return { ok: false, error: "Workspace path is empty", code: "EMPTY" };
  }

  // Expand leading ~
  let expanded = raw;
  if (expanded === "~") expanded = homedir();
  else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = resolve(homedir(), expanded.slice(2));
  }

  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);

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
    // Ensure readable
    await access(abs, fsConstants.R_OK);
    return { ok: true, path: abs, base: basename(abs) || abs };
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
  }

  /**
   * @returns {Promise<{ path: string, base: string, lastUsedAt: number }[]>}
   */
  async list() {
    const data = await this.#read();
    return data.recents;
  }

  /**
   * Move path to front (or insert). Validates existence by default.
   * @param {string} inputPath
   * @param {{ skipValidate?: boolean }} [opts]
   * @returns {Promise<{ ok: true, path: string, recents: object[] } | { ok: false, error: string, code: string }>}
   */
  async touch(inputPath, opts = {}) {
    let abs = inputPath;
    let baseName = basename(String(inputPath || "")) || String(inputPath || "");

    if (!opts.skipValidate) {
      const resolved = await resolveWorkspace(inputPath);
      if (!resolved.ok) return resolved;
      abs = resolved.path;
      baseName = resolved.base;
    } else {
      const raw = String(inputPath ?? "").trim();
      if (!raw) {
        return { ok: false, error: "Workspace path is empty", code: "EMPTY" };
      }
      abs = isAbsolute(raw) ? resolve(raw) : resolve(raw);
      baseName = basename(abs) || abs;
    }

    const data = await this.#read();
    const now = Date.now();
    const filtered = data.recents.filter((r) => r.path !== abs);
    filtered.unshift({ path: abs, base: baseName, lastUsedAt: now });
    data.recents = filtered.slice(0, this.max);
    await this.#write(data);
    return { ok: true, path: abs, recents: data.recents };
  }

  /**
   * @param {string} path
   * @returns {Promise<boolean>} true if removed
   */
  async remove(path) {
    const abs = resolve(String(path || "").trim());
    const data = await this.#read();
    const before = data.recents.length;
    data.recents = data.recents.filter((r) => r.path !== abs);
    if (data.recents.length === before) return false;
    await this.#write(data);
    return true;
  }

  /**
   * Drop entries whose paths no longer exist (optional hygiene).
   * @returns {Promise<number>} number removed
   */
  async pruneMissing() {
    const data = await this.#read();
    const kept = [];
    let removed = 0;
    for (const r of data.recents) {
      try {
        const st = await stat(r.path);
        if (st.isDirectory()) kept.push(r);
        else removed++;
      } catch {
        removed++;
      }
    }
    if (removed > 0) {
      data.recents = kept;
      await this.#write(data);
    }
    return removed;
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
      // Corrupt file → start fresh rather than crash
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
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
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
