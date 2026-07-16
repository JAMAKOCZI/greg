/**
 * In-memory registry of live agent tabs (one bridge process each).
 */
import { basename } from "node:path";
import { titleFromPrompt } from "./text.mjs";

/**
 * @typedef {{
 *   bridge: { sessionId?: string|null, alive?: boolean, stop?: () => void },
 *   sse: Set<import('node:http').ServerResponse>,
 *   cwd: string,
 *   title: string|null,
 *   createdAt: number,
 *   lastActiveAt: number,
 * }} TabEntry
 */

/**
 * @typedef {{
 *   tabId: string,
 *   sessionId: string|null|undefined,
 *   cwd: string,
 *   cwdBase: string,
 *   title: string|null,
 *   createdAt: number,
 *   lastActiveAt: number,
 *   alive: boolean,
 * }} TabMeta
 */

export class TabRegistry {
  constructor() {
    /** @type {Map<string, TabEntry>} */
    this._tabs = new Map();
  }

  /**
   * @param {string} tabId
   * @param {{
   *   bridge: TabEntry['bridge'],
   *   cwd: string,
   *   title?: string|null,
   *   createdAt?: number,
   *   lastActiveAt?: number,
   *   sse?: Set<import('node:http').ServerResponse>,
   * }} opts
   * @returns {TabEntry}
   */
  create(tabId, opts) {
    const now = Date.now();
    const title =
      typeof opts.title === "string" && opts.title.trim()
        ? opts.title.trim()
        : null;
    const entry = {
      bridge: opts.bridge,
      sse: opts.sse || new Set(),
      cwd: opts.cwd,
      title,
      createdAt: opts.createdAt ?? now,
      lastActiveAt: opts.lastActiveAt ?? now,
    };
    this._tabs.set(tabId, entry);
    return entry;
  }

  /**
   * @param {string} tabId
   * @returns {TabEntry|undefined}
   */
  get(tabId) {
    return this._tabs.get(tabId);
  }

  /**
   * @param {string} tabId
   * @returns {boolean}
   */
  has(tabId) {
    return this._tabs.has(tabId);
  }

  /**
   * @param {string} tabId
   * @returns {boolean} true if deleted
   */
  delete(tabId) {
    return this._tabs.delete(tabId);
  }

  /**
   * @param {string} tabId
   * @param {number} [now]
   * @returns {TabEntry|undefined}
   */
  touch(tabId, now = Date.now()) {
    const entry = this._tabs.get(tabId);
    if (!entry) return undefined;
    entry.lastActiveAt = now;
    return entry;
  }

  /**
   * @param {string} tabId
   * @param {string|null} title
   * @param {number} [now]
   * @returns {TabEntry|undefined}
   */
  setTitle(tabId, title, now = Date.now()) {
    const entry = this._tabs.get(tabId);
    if (!entry) return undefined;
    const next =
      typeof title === "string" ? title.trim() || null : title == null ? null : null;
    entry.title = next;
    entry.lastActiveAt = now;
    return entry;
  }

  /**
   * Set title from first prompt when the tab has no title yet.
   * @param {string} tabId
   * @param {string} promptText
   * @param {number} [now]
   * @returns {string|null|undefined} title after call, or undefined if missing tab
   */
  ensureTitleFromPrompt(tabId, promptText, now = Date.now()) {
    const entry = this._tabs.get(tabId);
    if (!entry) return undefined;
    entry.lastActiveAt = now;
    if (!entry.title) {
      entry.title = titleFromPrompt(promptText);
    }
    return entry.title;
  }

  /**
   * @param {string} tabId
   * @returns {TabMeta|null}
   */
  meta(tabId) {
    const entry = this._tabs.get(tabId);
    if (!entry) return null;
    return tabMeta(tabId, entry);
  }

  /**
   * Active tabs sorted by lastActiveAt descending.
   * @returns {TabMeta[]}
   */
  list() {
    /** @type {TabMeta[]} */
    const out = [];
    for (const [tabId, entry] of this._tabs) {
      out.push(tabMeta(tabId, entry));
    }
    out.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return out;
  }

  /**
   * @returns {IterableIterator<[string, TabEntry]>}
   */
  entries() {
    return this._tabs.entries();
  }

  get size() {
    return this._tabs.size;
  }
}

/**
 * @param {string} tabId
 * @param {TabEntry} entry
 * @returns {TabMeta}
 */
export function tabMeta(tabId, entry) {
  return {
    tabId,
    sessionId: entry.bridge?.sessionId ?? null,
    cwd: entry.cwd,
    cwdBase: basename(entry.cwd) || entry.cwd,
    title: entry.title,
    createdAt: entry.createdAt,
    lastActiveAt: entry.lastActiveAt,
    alive: Boolean(entry.bridge?.alive),
  };
}
