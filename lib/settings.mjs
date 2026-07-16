/**
 * Greg-owned settings (~/.greg/settings.json) — UI defaults, not Grok auth.
 */
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * @typedef {{
 *   alwaysApprove: boolean,
 *   model: string|null,
 *   defaultCwd: string|null,
 *   theme: string,
 * }} GregSettings
 */

/** @type {GregSettings} */
export const DEFAULT_SETTINGS = Object.freeze({
  alwaysApprove: false,
  model: null,
  defaultCwd: null,
  theme: "dark",
});

/**
 * @param {string} [path]
 * @returns {string}
 */
export function defaultSettingsPath(path) {
  if (path) return path;
  return resolve(homedir(), ".greg", "settings.json");
}

/**
 * Normalize a partial settings object against defaults.
 * @param {unknown} raw
 * @returns {GregSettings}
 */
export function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const model =
    typeof src.model === "string" && src.model.trim()
      ? src.model.trim()
      : null;
  const defaultCwd =
    typeof src.defaultCwd === "string" && src.defaultCwd.trim()
      ? src.defaultCwd.trim()
      : null;
  const theme =
    typeof src.theme === "string" && src.theme.trim()
      ? src.theme.trim()
      : DEFAULT_SETTINGS.theme;

  return {
    // Strict boolean — only true is true (avoid Boolean("false") === true)
    alwaysApprove: src.alwaysApprove === true,
    model,
    defaultCwd,
    theme,
  };
}

/**
 * Merge patch into current settings (partial update).
 * @param {GregSettings} current
 * @param {Record<string, unknown>} patch
 * @returns {GregSettings}
 */
export function mergeSettings(current, patch) {
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, "alwaysApprove")) {
    next.alwaysApprove = patch.alwaysApprove === true;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "model")) {
    const m = patch.model;
    next.model =
      m == null || m === ""
        ? null
        : typeof m === "string" && m.trim()
          ? m.trim()
          : current.model;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "defaultCwd")) {
    const d = patch.defaultCwd;
    next.defaultCwd =
      d == null || d === ""
        ? null
        : typeof d === "string" && d.trim()
          ? d.trim()
          : current.defaultCwd;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "theme")) {
    const t = patch.theme;
    if (typeof t === "string" && t.trim()) next.theme = t.trim();
  }
  return normalizeSettings(next);
}

export class SettingsStore {
  /**
   * @param {{ filePath?: string }} [opts]
   */
  constructor(opts = {}) {
    this.filePath = defaultSettingsPath(opts.filePath);
    /** @type {Promise<unknown>} */
    this._lock = Promise.resolve();
    /** @type {GregSettings|null} */
    this._cache = null;
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
   * @returns {Promise<GregSettings>}
   */
  async load() {
    return this.#withLock(async () => {
      if (this._cache) return { ...this._cache };
      const settings = await this.#readFile();
      this._cache = settings;
      return { ...settings };
    });
  }

  /**
   * Replace settings entirely (after normalize).
   * @param {Partial<GregSettings> | Record<string, unknown>} next
   * @returns {Promise<GregSettings>}
   */
  async save(next) {
    return this.#withLock(async () => {
      const settings = normalizeSettings(next);
      await this.#writeFile(settings);
      this._cache = settings;
      return { ...settings };
    });
  }

  /**
   * Partial update.
   * @param {Record<string, unknown>} patch
   * @returns {Promise<GregSettings>}
   */
  async update(patch) {
    return this.#withLock(async () => {
      const current = this._cache || (await this.#readFile());
      const settings = mergeSettings(current, patch || {});
      await this.#writeFile(settings);
      this._cache = settings;
      return { ...settings };
    });
  }

  /** Drop in-memory cache (tests / reload). */
  invalidate() {
    this._cache = null;
  }

  async #readFile() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return normalizeSettings(JSON.parse(raw));
    } catch (err) {
      if (err?.code === "ENOENT") return { ...DEFAULT_SETTINGS };
      if (err instanceof SyntaxError) {
        console.warn(
          "[greg] settings.json is corrupt; using defaults:",
          this.filePath,
        );
        return { ...DEFAULT_SETTINGS };
      }
      throw err;
    }
  }

  /**
   * @param {GregSettings} settings
   */
  async #writeFile(settings) {
    const dir = resolve(this.filePath, "..");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const payload = JSON.stringify(settings, null, 2) + "\n";
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
