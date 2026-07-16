/**
 * Greg-owned durable transcripts under ~/.greg/sessions (or a custom root).
 * Atomic writes: write temp file then rename.
 */
import {
  access,
  constants as fsConstants,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

/** @typedef {"user"|"agent"|"system"|"tool"|"plan"|"permission"|"thought"} MessageRole */

/**
 * @typedef {{
 *   role: MessageRole,
 *   ts: number,
 *   text: string,
 *   meta?: Record<string, unknown>,
 * }} TranscriptMessage
 */

/**
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   title: string|null,
 *   createdAt: number,
 *   updatedAt: number,
 *   messages: TranscriptMessage[],
 * }} Transcript
 */

/**
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   cwdBase: string,
 *   title: string|null,
 *   createdAt: number,
 *   updatedAt: number,
 *   messageCount: number,
 * }} TranscriptSummary
 */

/**
 * @param {string} [rootDir]
 * @returns {string}
 */
export function defaultSessionsDir(rootDir) {
  if (rootDir) return rootDir;
  return join(homedir(), ".greg", "sessions");
}

export class TranscriptStore {
  /**
   * @param {{ rootDir?: string }} [opts]
   */
  constructor(opts = {}) {
    this.rootDir = defaultSessionsDir(opts.rootDir);
    /** @type {Map<string, Promise<unknown>>} per-id write serialization */
    this._locks = new Map();
  }

  /**
   * @returns {Promise<void>}
   */
  async ensureRoot() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(this.rootDir, 0o700);
    } catch {
      /* best-effort on platforms that ignore mode */
    }
  }

  /**
   * @param {string} id
   * @returns {string}
   */
  pathFor(id) {
    const safe = sanitizeId(id);
    return join(this.rootDir, `${safe}.json`);
  }

  /**
   * Serialize mutating operations per transcript id (prevents lost updates /
   * corrupt files when tool events and agent flush race).
   * @template T
   * @param {string} id
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withLock(id, fn) {
    const key = sanitizeId(id);
    const prev = this._locks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    // Keep the chain alive until we finish
    const chained = prev.then(() => gate);
    this._locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this._locks.get(key) === chained) this._locks.delete(key);
    }
  }

  /**
   * Create a new empty transcript.
   * @param {{ id?: string, cwd: string, title?: string|null, createdAt?: number, overwrite?: boolean }} opts
   *   When `overwrite` is false (default true for explicit create), return existing doc if present.
   * @returns {Promise<Transcript>}
   */
  async create(opts) {
    const id = opts.id || randomUUID();
    const overwrite = opts.overwrite !== false;
    return this.#withLock(id, async () => {
      await this.ensureRoot();
      if (!overwrite) {
        const existing = await this.load(id);
        if (existing) return existing;
      }
      const now = Date.now();
      /** @type {Transcript} */
      const doc = {
        id,
        cwd: opts.cwd,
        title:
          typeof opts.title === "string" && opts.title.trim()
            ? opts.title.trim()
            : null,
        createdAt: opts.createdAt ?? now,
        updatedAt: now,
        messages: [],
      };
      await this.#atomicWrite(doc);
      return doc;
    });
  }

  /**
   * Ensure a transcript exists; do not wipe prior messages.
   * @param {{ id: string, cwd: string, title?: string|null, createdAt?: number }} opts
   * @returns {Promise<Transcript>}
   */
  async ensure(opts) {
    return this.create({ ...opts, overwrite: false });
  }

  /**
   * @param {Transcript} doc
   * @returns {Promise<void>}
   */
  async save(doc) {
    if (!doc?.id) throw new Error("TranscriptStore.save: missing id");
    return this.#withLock(doc.id, async () => {
      await this.ensureRoot();
      const next = {
        ...doc,
        title:
          typeof doc.title === "string" && doc.title.trim()
            ? doc.title.trim()
            : null,
        messages: Array.isArray(doc.messages) ? doc.messages : [],
        updatedAt: Date.now(),
      };
      await this.#atomicWrite(next);
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<Transcript|null>}
   */
  async load(id) {
    const file = this.pathFor(id);
    try {
      const raw = await readFile(file, "utf8");
      const doc = JSON.parse(raw);
      if (!doc || typeof doc !== "object" || !doc.id) return null;
      return normalizeDoc(doc);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
      throw err;
    }
  }

  /**
   * @returns {Promise<TranscriptSummary[]>}
   */
  async list() {
    await this.ensureRoot();
    let names;
    try {
      names = await readdir(this.rootDir);
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }

    /** @type {TranscriptSummary[]} */
    const out = [];
    for (const name of names) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const doc = await this.load(id);
        if (!doc) continue;
        out.push(toSummary(doc));
      } catch {
        /* skip corrupt files */
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /**
   * @param {string} id
   * @param {Omit<TranscriptMessage, "ts"> & { ts?: number }} message
   * @param {{ title?: string|null }} [opts]
   * @returns {Promise<Transcript|null>}
   */
  async appendMessage(id, message, opts = {}) {
    return this.#withLock(id, async () => {
      let doc = await this.load(id);
      if (!doc) return null;

      const role = String(message.role || "system");
      if (!isRole(role)) {
        throw new Error(`TranscriptStore.appendMessage: invalid role ${role}`);
      }

      /** @type {TranscriptMessage} */
      const msg = {
        role,
        ts: message.ts ?? Date.now(),
        text: String(message.text ?? ""),
      };
      if (message.meta && typeof message.meta === "object") {
        msg.meta = message.meta;
      }
      doc.messages.push(msg);
      doc.updatedAt = Date.now();
      if (opts.title !== undefined) {
        doc.title =
          typeof opts.title === "string" && opts.title.trim()
            ? opts.title.trim()
            : null;
      }
      await this.#atomicWrite(doc);
      return doc;
    });
  }

  /**
   * Upsert a tool row by meta.toolCallId (avoids spam from tool_call_update).
   * @param {string} id
   * @param {Omit<TranscriptMessage, "ts"|"role"> & { ts?: number, meta?: Record<string, unknown> }} message
   * @returns {Promise<Transcript|null>}
   */
  async upsertToolMessage(id, message) {
    return this.#withLock(id, async () => {
      const doc = await this.load(id);
      if (!doc) return null;
      const toolCallId = message.meta?.toolCallId;
      const text = String(message.text ?? "");
      const ts = message.ts ?? Date.now();
      if (toolCallId) {
        const idx = doc.messages.findLastIndex(
          (m) =>
            m.role === "tool" &&
            m.meta &&
            m.meta.toolCallId === toolCallId,
        );
        if (idx >= 0) {
          doc.messages[idx] = {
            role: "tool",
            ts,
            text,
            meta: { ...(doc.messages[idx].meta || {}), ...(message.meta || {}) },
          };
          doc.updatedAt = Date.now();
          await this.#atomicWrite(doc);
          return doc;
        }
      }
      doc.messages.push({
        role: "tool",
        ts,
        text,
        ...(message.meta ? { meta: message.meta } : {}),
      });
      doc.updatedAt = Date.now();
      await this.#atomicWrite(doc);
      return doc;
    });
  }

  /**
   * Replace the last plan message (or append if none).
   * @param {string} id
   * @param {string} text
   * @returns {Promise<Transcript|null>}
   */
  async upsertPlanMessage(id, text) {
    return this.#withLock(id, async () => {
      const doc = await this.load(id);
      if (!doc) return null;
      const idx = doc.messages.findLastIndex((m) => m.role === "plan");
      const msg = {
        role: /** @type {const} */ ("plan"),
        ts: Date.now(),
        text: String(text || "(plan)"),
      };
      if (idx >= 0) doc.messages[idx] = msg;
      else doc.messages.push(msg);
      doc.updatedAt = Date.now();
      await this.#atomicWrite(doc);
      return doc;
    });
  }

  /**
   * @param {string} id
   * @param {string|null} title
   * @returns {Promise<Transcript|null>}
   */
  async setTitle(id, title) {
    return this.#withLock(id, async () => {
      const doc = await this.load(id);
      if (!doc) return null;
      doc.title =
        typeof title === "string" && title.trim() ? title.trim() : null;
      doc.updatedAt = Date.now();
      await this.#atomicWrite(doc);
      return doc;
    });
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} true if deleted
   */
  async delete(id) {
    return this.#withLock(id, async () => {
      const file = this.pathFor(id);
      try {
        await access(file, fsConstants.F_OK);
      } catch (err) {
        if (err?.code === "ENOENT") return false;
        throw err;
      }
      await rm(file, { force: false });
      return true;
    });
  }

  /**
   * @param {Transcript} doc
   */
  async #atomicWrite(doc) {
    await this.ensureRoot();
    const file = this.pathFor(doc.id);
    const tmp = join(
      this.rootDir,
      `.${sanitizeId(doc.id)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const payload = JSON.stringify(doc, null, 2) + "\n";
    try {
      const fh = await open(tmp, "w", 0o600);
      try {
        await fh.writeFile(payload, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, file);
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

/**
 * @param {string} id
 */
function sanitizeId(id) {
  const s = String(id || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) {
    throw new Error(`Invalid transcript id: ${id}`);
  }
  // Allow UUID and simple slug chars
  if (!/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(`Invalid transcript id characters: ${id}`);
  }
  return s;
}

/**
 * @param {string} role
 * @returns {role is MessageRole}
 */
function isRole(role) {
  return (
    role === "user" ||
    role === "agent" ||
    role === "system" ||
    role === "tool" ||
    role === "plan" ||
    role === "permission" ||
    role === "thought"
  );
}

/**
 * @param {object} doc
 * @returns {Transcript}
 */
function normalizeDoc(doc) {
  return {
    id: String(doc.id),
    cwd: String(doc.cwd || ""),
    title:
      typeof doc.title === "string" && doc.title.trim()
        ? doc.title.trim()
        : null,
    createdAt: Number(doc.createdAt) || 0,
    updatedAt: Number(doc.updatedAt) || 0,
    messages: Array.isArray(doc.messages)
      ? doc.messages.map((m) => ({
          role: isRole(m?.role) ? m.role : "system",
          ts: Number(m?.ts) || 0,
          text: String(m?.text ?? ""),
          ...(m?.meta && typeof m.meta === "object" ? { meta: m.meta } : {}),
        }))
      : [],
  };
}

/**
 * @param {Transcript} doc
 * @returns {TranscriptSummary}
 */
function toSummary(doc) {
  return {
    id: doc.id,
    cwd: doc.cwd,
    cwdBase: basename(doc.cwd) || doc.cwd,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    messageCount: doc.messages.length,
  };
}
