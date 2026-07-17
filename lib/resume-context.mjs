/**
 * Build a text seed so a fresh ACP session can continue a Greg transcript.
 *
 * Grok agent starts empty on every `session/new`. Greg owns durable history
 * under ~/.greg/sessions; this module turns that history into a compact
 * preamble prepended to the *first* real user prompt after resume.
 * The seed is never written back into the transcript.
 */

/** @typedef {{ role?: string, text?: string, meta?: Record<string, unknown> }} SeedMessage */

export const DEFAULT_MAX_CHARS = 24_000;
export const DEFAULT_MAX_PER_MESSAGE = 2_500;
export const DEFAULT_MAX_MESSAGES = 50;

const HEADER = `[Prior conversation context restored by Greg.
This is background only — do not re-answer or re-summarize past turns unless the user asks.
Continue naturally from the user's next message after "User's new message:".]`;

const FOOTER = `[End of restored context.]`;

/**
 * @param {SeedMessage[]} messages
 * @param {{
 *   maxChars?: number,
 *   maxPerMessage?: number,
 *   maxMessages?: number,
 * }} [opts]
 * @returns {{
 *   text: string,
 *   messageCount: number,
 *   charCount: number,
 *   truncated: boolean,
 *   omitted: number,
 * } | null}
 */
export function buildResumeContextSeed(messages, opts = {}) {
  const maxChars = positiveInt(opts.maxChars, DEFAULT_MAX_CHARS);
  const maxPerMessage = positiveInt(opts.maxPerMessage, DEFAULT_MAX_PER_MESSAGE);
  const maxMessages = positiveInt(opts.maxMessages, DEFAULT_MAX_MESSAGES);

  if (!Array.isArray(messages) || messages.length === 0) return null;

  /** @type {{ label: string, body: string }[]} */
  const lines = [];
  for (const m of messages) {
    const mapped = mapMessage(m, maxPerMessage);
    if (mapped) lines.push(mapped);
  }
  if (lines.length === 0) return null;

  // Prefer the most recent turns when over budget
  let selected = lines;
  let omitted = 0;
  if (selected.length > maxMessages) {
    omitted = selected.length - maxMessages;
    selected = selected.slice(-maxMessages);
  }

  // Fit char budget from the end (recent first)
  const overhead = HEADER.length + FOOTER.length + 4; // blank lines
  let budget = Math.max(0, maxChars - overhead);
  /** @type {string[]} */
  const keptBodies = [];
  let truncated = omitted > 0;

  for (let i = selected.length - 1; i >= 0; i--) {
    const block = `${selected[i].label}${selected[i].body}`;
    const cost = block.length + (keptBodies.length ? 2 : 0); // \n\n between
    if (cost > budget) {
      truncated = true;
      // Try a hard-truncated tail of this message if nothing kept yet
      if (keptBodies.length === 0 && budget > 40) {
        const label = selected[i].label;
        const room = budget - label.length - 1;
        if (room > 20) {
          keptBodies.unshift(`${label}${clip(selected[i].body, room)}`);
          budget = 0;
        }
      }
      omitted += i + 1;
      break;
    }
    keptBodies.unshift(block);
    budget -= cost;
  }

  if (keptBodies.length === 0) return null;

  const parts = [HEADER];
  if (truncated || omitted > 0) {
    parts.push(
      `[Note: earlier turns were omitted to fit the context budget` +
        (omitted > 0 ? ` (~${omitted} messages)` : "") +
        `.]`,
    );
  }
  parts.push(keptBodies.join("\n\n"));
  parts.push(FOOTER);

  const text = parts.join("\n\n");
  return {
    text,
    messageCount: keptBodies.length,
    charCount: text.length,
    truncated: truncated || omitted > 0,
    omitted,
  };
}

/**
 * Prepend seed to the first real user prompt after resume.
 * @param {string} userText
 * @param {string|null|undefined} seedText
 * @returns {string}
 */
export function applyContextSeed(userText, seedText) {
  const user = String(userText ?? "");
  const seed = typeof seedText === "string" ? seedText.trim() : "";
  if (!seed) return user;
  return `${seed}\n\n---\n\nUser's new message:\n${user}`;
}

/**
 * @param {SeedMessage} m
 * @param {number} maxPerMessage
 * @returns {{ label: string, body: string } | null}
 */
function mapMessage(m, maxPerMessage) {
  if (!m || typeof m !== "object") return null;
  const role = String(m.role || "");
  const raw = typeof m.text === "string" ? m.text.trim() : "";

  if (role === "user") {
    if (!raw) return null;
    return { label: "User: ", body: clip(raw, maxPerMessage) };
  }
  if (role === "agent") {
    if (!raw) return null;
    return { label: "Assistant: ", body: clip(raw, maxPerMessage) };
  }
  if (role === "tool") {
    const title =
      (typeof m.meta?.title === "string" && m.meta.title.trim()) ||
      (typeof m.meta?.kind === "string" && m.meta.kind.trim()) ||
      "tool";
    const status =
      typeof m.meta?.status === "string" && m.meta.status.trim()
        ? ` (${m.meta.status.trim()})`
        : "";
    // Prefer short tool line; include a little text if useful
    const snippet = raw ? clip(raw, Math.min(400, maxPerMessage)) : "";
    const body = snippet
      ? `${title}${status}: ${snippet}`
      : `${title}${status}`;
    return { label: "Tool: ", body: clip(body, maxPerMessage) };
  }
  if (role === "plan") {
    if (!raw) return null;
    return { label: "Plan: ", body: clip(raw, Math.min(800, maxPerMessage)) };
  }
  // system / thought / permission — skip (noise or already visible in UI only)
  return null;
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
 * @param {unknown} n
 * @param {number} fallback
 */
function positiveInt(n, fallback) {
  if (typeof n === "number" && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return fallback;
}
