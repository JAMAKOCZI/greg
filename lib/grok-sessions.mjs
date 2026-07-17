/**
 * Read-only bridge from Grok Build's on-disk sessions (~/.grok/sessions)
 * into Greg transcript shape.
 *
 * Upstream layout (observed, chat_format_version 1 — treat as unstable):
 *   ~/.grok/sessions/<url-encoded-cwd>/<session-uuid>/
 *     summary.json
 *     chat_history.jsonl
 *
 * Greg NEVER writes under ~/.grok — only reads.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { titleFromPrompt } from "./text.mjs";

/** Max tool/result text kept when converting (chars). */
export const MAX_TOOL_TEXT = 2_000;
/** Max thought/reasoning text kept. */
export const MAX_THOUGHT_TEXT = 1_500;
/** Soft cap on converted messages (drop oldest non-user if exceeded). */
export const MAX_IMPORT_MESSAGES = 500;
/** Default list size for GET /api/import/grok */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * @param {string} [rootDir]
 * @returns {string}
 */
export function defaultGrokSessionsDir(rootDir) {
  if (rootDir) return rootDir;
  return join(homedir(), ".grok", "sessions");
}

/**
 * @typedef {{
 *   id: string,
 *   cwd: string,
 *   cwdBase: string,
 *   title: string|null,
 *   createdAt: number,
 *   updatedAt: number,
 *   messageCount: number,
 *   model: string|null,
 *   kind: string|null,
 *   agentName: string|null,
 *   path: string,
 * }} GrokSessionSummary
 */

/**
 * List Grok sessions by walking for summary.json (read-only).
 * Sorted by updatedAt desc. Corrupt / empty summaries skipped.
 *
 * @param {{
 *   rootDir?: string,
 *   limit?: number,
 *   minChatMessages?: number,
 * }} [opts]
 * @returns {Promise<GrokSessionSummary[]>}
 */
export async function listGrokSessions(opts = {}) {
  const rootDir = defaultGrokSessionsDir(opts.rootDir);
  const limit = clampInt(opts.limit, 1, 500, DEFAULT_LIST_LIMIT);
  const minChat = clampInt(opts.minChatMessages, 0, 1_000_000, 0);

  /** @type {GrokSessionSummary[]} */
  const out = [];
  try {
    await walkForSummaries(rootDir, out, 0);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }

  const filtered =
    minChat > 0
      ? out.filter((s) => s.messageCount >= minChat)
      : out;

  filtered.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  return filtered.slice(0, limit);
}

/**
 * Load one session by id (scan under root). Read-only.
 *
 * @param {string} sessionId
 * @param {{ rootDir?: string }} [opts]
 * @returns {Promise<{
 *   summary: GrokSessionSummary,
 *   rawSummary: object,
 *   items: object[],
 * } | null>}
 */
export async function loadGrokSession(sessionId, opts = {}) {
  const id = String(sessionId || "").trim();
  if (!id) return null;
  const rootDir = defaultGrokSessionsDir(opts.rootDir);
  const found = await findSessionDir(rootDir, id);
  if (!found) return null;

  const rawSummary = await readJsonFile(join(found, "summary.json"));
  if (!rawSummary) return null;
  const summary = summaryFromRaw(rawSummary, found);
  if (!summary) return null;

  const items = await readChatHistoryJsonl(join(found, "chat_history.jsonl"));
  return { summary, rawSummary, items };
}

/**
 * Convert Grok chat_history items + summary into a Greg transcript document
 * (in memory only — caller persists via TranscriptStore).
 *
 * @param {GrokSessionSummary} summary
 * @param {object[]} items
 * @param {{ id?: string, importedAt?: number }} [opts]
 * @returns {{
 *   id: string,
 *   cwd: string,
 *   title: string|null,
 *   createdAt: number,
 *   updatedAt: number,
 *   messages: Array<{ role: string, ts: number, text: string, meta?: object }>,
 *   source: { kind: "grok", sessionId: string, path: string, importedAt: number },
 * }}
 */
export function grokSessionToTranscript(summary, items, opts = {}) {
  const id = opts.id || summary.id;
  const importedAt = opts.importedAt ?? Date.now();
  const tsBase = summary.createdAt || importedAt;

  /** @type {Array<{ role: string, ts: number, text: string, meta?: object }>} */
  const messages = [];
  messages.push({
    role: "system",
    ts: tsBase,
    text: `Imported from Grok Build session ${summary.id}`,
    meta: {
      source: "grok",
      grokSessionId: summary.id,
      model: summary.model,
      kind: summary.kind,
    },
  });

  let i = 0;
  for (const item of items || []) {
    const mapped = mapGrokItem(item, tsBase + ++i * 10);
    if (!mapped) continue;
    if (Array.isArray(mapped)) messages.push(...mapped);
    else messages.push(mapped);
  }

  // Cap very large imports (keep newest)
  let finalMessages = messages;
  if (finalMessages.length > MAX_IMPORT_MESSAGES) {
    const head = finalMessages[0]; // keep import system note
    const tail = finalMessages.slice(-(MAX_IMPORT_MESSAGES - 1));
    finalMessages = [head, ...tail];
  }

  let title = summary.title;
  if (!title) {
    const firstUser = finalMessages.find((m) => m.role === "user" && m.text.trim());
    if (firstUser) title = titleFromPrompt(firstUser.text) || null;
  }

  return {
    id,
    cwd: summary.cwd || "",
    title,
    createdAt: summary.createdAt || importedAt,
    updatedAt: summary.updatedAt || importedAt,
    messages: finalMessages,
    source: {
      kind: "grok",
      sessionId: summary.id,
      path: summary.path,
      importedAt,
    },
  };
}

/**
 * @param {object} item
 * @param {number} ts
 * @returns {object|object[]|null}
 */
export function mapGrokItem(item, ts = Date.now()) {
  if (!item || typeof item !== "object") return null;
  const type = String(item.type || "").toLowerCase();

  if (type === "system") return null;

  if (type === "user") {
    // Injected reminders / synthetic system noise
    if (item.synthetic_reason) return null;
    const text = extractText(item.content);
    if (!text.trim()) return null;
    // Skip pure system-reminder blobs
    if (isOnlySystemReminder(text)) return null;
    const cleaned = stripSystemReminders(text).trim();
    if (!cleaned) return null;
    return { role: "user", ts, text: cleaned };
  }

  if (type === "assistant") {
    /** @type {object[]} */
    const out = [];
    const text = extractText(item.content);
    if (text.trim()) {
      out.push({ role: "agent", ts, text: text.trim() });
    }
    const calls = Array.isArray(item.tool_calls) ? item.tool_calls : [];
    for (const call of calls) {
      const name = String(call?.name || call?.tool || "tool");
      const id = call?.id != null ? String(call.id) : undefined;
      let args = "";
      if (typeof call?.arguments === "string") args = call.arguments;
      else if (call?.arguments != null) {
        try {
          args = JSON.stringify(call.arguments);
        } catch {
          args = String(call.arguments);
        }
      }
      const body = args ? `${name}: ${clip(args, MAX_TOOL_TEXT)}` : name;
      out.push({
        role: "tool",
        ts: ts + 1,
        text: body,
        meta: {
          toolCallId: id,
          title: name,
          kind: name,
          status: "completed",
          source: "grok",
        },
      });
    }
    return out.length ? out : null;
  }

  if (type === "reasoning") {
    const text = extractReasoningText(item);
    if (!text.trim()) return null;
    return {
      role: "thought",
      ts,
      text: clip(text.trim(), MAX_THOUGHT_TEXT),
      meta: { source: "grok", reasoningId: item.id },
    };
  }

  if (type === "tool_result") {
    const text = extractText(item.content);
    const id = item.tool_call_id != null ? String(item.tool_call_id) : undefined;
    const body = text.trim()
      ? clip(text.trim(), MAX_TOOL_TEXT)
      : "(empty tool result)";
    return {
      role: "tool",
      ts,
      text: body,
      meta: {
        toolCallId: id,
        title: "tool_result",
        kind: "tool_result",
        status: "completed",
        source: "grok",
      },
    };
  }

  if (type === "backend_tool_call") {
    const name = String(item.name || item.tool || "backend_tool");
    return {
      role: "tool",
      ts,
      text: name,
      meta: {
        title: name,
        kind: "backend_tool_call",
        status: "completed",
        source: "grok",
      },
    };
  }

  return null;
}

/**
 * Extract plain text from Grok content (string | content parts[]).
 * @param {unknown} content
 * @returns {string}
 */
export function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (typeof p === "string") parts.push(p);
      else if (p && typeof p === "object") {
        if (typeof p.text === "string") parts.push(p.text);
        else if (typeof p.content === "string") parts.push(p.content);
      }
    }
    return parts.join("");
  }
  if (typeof content === "object" && content !== null) {
    const o = /** @type {Record<string, unknown>} */ (content);
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

// ── internals ──────────────────────────────────────────────────────────

/**
 * @param {string} dir
 * @param {GrokSessionSummary[]} out
 * @param {number} depth
 */
async function walkForSummaries(dir, out, depth) {
  // sessions/<cwd-enc>/<uuid>/summary.json — depth rarely > 4
  if (depth > 6) return;
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of names) {
    if (!ent.isDirectory()) {
      // Also accept summary.json directly under dir (uuid leaf)
      continue;
    }
    // Skip obvious non-session noise
    if (ent.name.startsWith(".")) continue;
    const child = join(dir, ent.name);
    const summaryPath = join(child, "summary.json");
    try {
      await stat(summaryPath);
      const raw = await readJsonFile(summaryPath);
      const sum = raw ? summaryFromRaw(raw, child) : null;
      if (sum) out.push(sum);
      else await walkForSummaries(child, out, depth + 1);
    } catch {
      // Not a leaf session dir — descend
      await walkForSummaries(child, out, depth + 1);
    }
  }
}

/**
 * @param {string} rootDir
 * @param {string} sessionId
 * @returns {Promise<string|null>} absolute path to session dir
 */
async function findSessionDir(rootDir, sessionId) {
  /** @type {string[]} */
  const stack = [rootDir];
  let steps = 0;
  while (stack.length && steps < 50_000) {
    steps++;
    const dir = stack.pop();
    let names;
    try {
      names = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of names) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".")) continue;
      const child = join(dir, ent.name);
      if (ent.name === sessionId) {
        // Confirm summary exists
        try {
          await stat(join(child, "summary.json"));
          return child;
        } catch {
          /* not a session leaf */
        }
      }
      stack.push(child);
    }
  }
  return null;
}

/**
 * @param {object} raw
 * @param {string} sessionPath
 * @returns {GrokSessionSummary|null}
 */
function summaryFromRaw(raw, sessionPath) {
  if (!raw || typeof raw !== "object") return null;
  const info = raw.info && typeof raw.info === "object" ? raw.info : {};
  const id = String(info.id || basename(sessionPath) || "").trim();
  if (!id) return null;
  const cwd = String(info.cwd || "").trim();
  const titleRaw =
    (typeof raw.generated_title === "string" && raw.generated_title.trim()) ||
    (typeof raw.session_summary === "string" && raw.session_summary.trim()) ||
    "";
  const createdAt = parseIsoMs(raw.created_at) || 0;
  const updatedAt =
    parseIsoMs(raw.last_active_at) ||
    parseIsoMs(raw.updated_at) ||
    createdAt;
  const messageCount = Number(
    raw.num_chat_messages ?? raw.num_messages ?? 0,
  );
  return {
    id,
    cwd,
    cwdBase: cwd ? basename(cwd) || cwd : "",
    title: titleRaw || null,
    createdAt,
    updatedAt,
    messageCount: Number.isFinite(messageCount) ? messageCount : 0,
    model:
      typeof raw.current_model_id === "string" ? raw.current_model_id : null,
    kind: typeof raw.session_kind === "string" ? raw.session_kind : null,
    agentName: typeof raw.agent_name === "string" ? raw.agent_name : null,
    path: sessionPath,
  };
}

/**
 * @param {string} file
 * @returns {Promise<object[]>}
 */
async function readChatHistoryJsonl(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }
  /** @type {object[]} */
  const items = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object") items.push(o);
    } catch {
      /* skip corrupt line */
    }
  }
  return items;
}

/**
 * @param {string} path
 * @returns {Promise<object|null>}
 */
async function readJsonFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return null;
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} item
 */
function extractReasoningText(item) {
  if (typeof item.content === "string") return item.content;
  const summary = item.summary;
  if (Array.isArray(summary)) {
    const parts = [];
    for (const s of summary) {
      if (typeof s === "string") parts.push(s);
      else if (s && typeof s.text === "string") parts.push(s.text);
      else if (s && typeof s.summary_text === "string") parts.push(s.summary_text);
    }
    return parts.join("\n");
  }
  return extractText(item.content);
}

/**
 * @param {string} text
 */
function isOnlySystemReminder(text) {
  const t = text.trim();
  return (
    t.startsWith("<system-reminder>") &&
    t.endsWith("</system-reminder>") &&
    t.indexOf("<system-reminder>") === t.lastIndexOf("<system-reminder>")
  );
}

/**
 * @param {string} text
 */
function stripSystemReminders(text) {
  return String(text).replace(
    /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
    "",
  );
}

/**
 * @param {string} s
 * @param {number} max
 */
function clip(s, max) {
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return `${s.slice(0, max - 1)}…`;
}

/**
 * @param {unknown} iso
 * @returns {number}
 */
function parseIsoMs(iso) {
  if (typeof iso !== "string" || !iso.trim()) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param {unknown} n
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampInt(n, min, max, fallback) {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
