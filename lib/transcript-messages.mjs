/**
 * Transcript message helpers: collapse race duplicates, build tool meta for history cards.
 */

import { isDecorativeOnlyMarkdown } from "./text.mjs";

/** Soft cap so one shell dump does not blow ~/.greg JSON. */
export const TOOL_META_MAX_CHARS = 200_000;

/**
 * Prefix-collapse consecutive agent rows only when timestamps are close
 * (partial double-flush race). Missing ts → treat as close (legacy rows).
 */
export const AGENT_PREFIX_COLLAPSE_MS = 3_000;

/**
 * Clip large tool payloads before persisting.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {unknown}
 */
export function clipForTranscript(value, max = TOOL_META_MAX_CHARS) {
  if (value == null) return undefined;
  try {
    if (typeof value === "string") {
      return value.length > max
        ? `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`
        : value;
    }
    const s = JSON.stringify(value);
    if (s.length <= max) return value;
    return {
      _gregTruncated: true,
      preview: s.slice(0, max),
      originalChars: s.length,
    };
  } catch {
    return undefined;
  }
}

/**
 * Merge tool meta without letting sparse updates wipe richer fields.
 * @param {Record<string, unknown>|null|undefined} prev
 * @param {Record<string, unknown>|null|undefined} next
 * @returns {Record<string, unknown>}
 */
export function mergeToolMeta(prev, next) {
  const out = { ...(prev && typeof prev === "object" ? prev : {}) };
  if (!next || typeof next !== "object") return out;
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Build durable tool meta from an ACP tool_call / tool_call_update payload.
 * @param {Record<string, unknown>} update
 * @returns {Record<string, unknown>}
 */
export function buildToolMetaFromUpdate(update) {
  const u = update && typeof update === "object" ? update : {};
  /** @type {Record<string, unknown>} */
  const meta = {};
  const toolCallId = u.toolCallId || u.tool_call_id || u.id;
  if (toolCallId) meta.toolCallId = String(toolCallId);
  if (u.status != null && u.status !== "") meta.status = String(u.status);
  if (u.kind != null && u.kind !== "") meta.kind = String(u.kind);
  if (u.title != null && u.title !== "") meta.title = String(u.title);
  else if (u.toolName || u.tool_name || u.name) {
    meta.title = String(u.toolName || u.tool_name || u.name);
  }
  if (Array.isArray(u.locations) && u.locations.length) {
    meta.locations = u.locations;
  }
  const rawIn = u.rawInput ?? u.raw_input ?? u.input;
  if (rawIn != null && rawIn !== "") {
    meta.rawInput = clipForTranscript(rawIn);
  }
  const rawOut = u.rawOutput ?? u.raw_output ?? u.output;
  if (rawOut != null && rawOut !== "") {
    meta.rawOutput = clipForTranscript(rawOut);
  }
  if (Array.isArray(u.content) && u.content.length) {
    meta.content = clipForTranscript(u.content);
  }
  return meta;
}

/**
 * @param {{ ts?: unknown }} a
 * @param {{ ts?: unknown }} b
 * @returns {boolean}
 */
function agentTsClose(a, b) {
  const ta = Number(a?.ts);
  const tb = Number(b?.ts);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return true;
  return Math.abs(tb - ta) <= AGENT_PREFIX_COLLAPSE_MS;
}

/**
 * Legacy resume/restart markers once written on every session/new — hide them.
 * Live UI uses a single "Resumed · path · model context…" line instead.
 * @param {unknown} text
 * @returns {boolean}
 */
export function isBoilerplateResumeSystem(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (t === "Session restarted") return true;
  if (t === "Session resumed — continue in this chat") return true;
  // Older / variant copies
  if (/^Session resumed\b/i.test(t) && t.length < 120) return true;
  return false;
}

/**
 * Permission / ACP request rows that used to clutter durable history.
 * Live UI still shows interactive permission cards over SSE.
 * @param {{ role?: string, text?: unknown }} m
 * @returns {boolean}
 */
export function isNoisePermissionHistory(m) {
  if (!m || typeof m !== "object") return false;
  if (m.role === "permission") return true;
  if (
    (m.role === "system" || m.role === "permission") &&
    /^Agent request:\s*/i.test(String(m.text ?? "").trim())
  ) {
    return true;
  }
  return false;
}

/**
 * Collapse duplicate/partial agent rows caused by concurrent buffer flushes.
 * - Drop decorative-only agent texts (`---`, blank)
 * - Drop legacy resume/restart system noise and Agent request rows
 * - Drop identical consecutive agent texts
 * - If one agent text is a prefix of the next *and* timestamps are close, keep longer
 * @param {Array<{ role?: string, text?: string, [k: string]: unknown }>} messages
 * @returns {typeof messages}
 */
export function collapseTranscriptMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  /** @type {typeof messages} */
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "agent" && isDecorativeOnlyMarkdown(m.text)) continue;
    if (m.role === "system" && isBoilerplateResumeSystem(m.text)) continue;
    if (isNoisePermissionHistory(m)) continue;
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.role === "agent" &&
      m.role === "agent" &&
      typeof prev.text === "string" &&
      typeof m.text === "string"
    ) {
      if (m.text === prev.text) continue;
      if (agentTsClose(prev, m)) {
        if (m.text.startsWith(prev.text)) {
          out[out.length - 1] = m;
          continue;
        }
        if (prev.text.startsWith(m.text)) {
          continue;
        }
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * One-line summary for tool history rows (list / resume seed).
 * @param {Record<string, unknown>} update
 * @returns {string}
 */
export function toolSummaryText(update) {
  const u = update && typeof update === "object" ? update : {};
  const title =
    u.title ||
    u.toolName ||
    u.tool_name ||
    u.name ||
    u.kind ||
    u.toolCallId ||
    "tool";
  const status = u.status ? ` · ${u.status}` : "";
  return `${title}${status}`;
}
