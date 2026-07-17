/**
 * Rich transcript cards for ACP tool_call / tool_call_update / plan / diffs.
 * Defensive against shape drift across agents.
 */

export function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Strip CSI/OSC ANSI color codes from shell/tool output.
 * PowerShell Format-Table paints headers/underlines green (`[32;1m----`);
 * those underlines look like stray green bars in the transcript.
 * @param {unknown} text
 * @returns {string}
 */
export function stripAnsi(text) {
  return String(text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      "",
    )
    // stray ESC leftovers
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b/g, "");
}

/** @param {unknown} v */
export function prettyJson(v, max = 4000) {
  try {
    const s = stripAnsi(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    if (s == null) return "";
    return s.length > max ? `${s.slice(0, max)}\n…` : s;
  } catch {
    return stripAnsi(String(v));
  }
}

/**
 * Normalize ACP tool status strings.
 * @param {unknown} status
 * @returns {"pending"|"running"|"completed"|"failed"|"unknown"}
 */
export function normalizeStatus(status) {
  const s = String(status || "")
    .toLowerCase()
    .replace(/-/g, "_");
  if (!s) return "pending";
  if (s === "pending" || s === "queued" || s === "waiting") return "pending";
  if (s === "in_progress" || s === "running" || s === "started" || s === "active")
    return "running";
  if (s === "completed" || s === "complete" || s === "success" || s === "ok" || s === "done")
    return "completed";
  if (s === "failed" || s === "error" || s === "cancelled" || s === "canceled")
    return "failed";
  return "unknown";
}

/**
 * @param {"pending"|"running"|"completed"|"failed"|"unknown"} status
 */
export function statusLabel(status) {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return status || "unknown";
  }
}

/**
 * One-line human summary for failed tools (hide transport/internal noise).
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
/**
 * Compact title for noisy execute/bash cards (full command lives in input).
 * @param {string} title
 * @param {string} [kind]
 * @returns {string}
 */
export function compactToolTitle(title, kind = "") {
  const t = String(title || "").trim();
  const k = String(kind || "").toLowerCase();
  if (!t) return k || "tool";
  // ACP often sets title to: Execute `long command…`
  if (/^execute\b/i.test(t) || k === "execute" || k === "bash" || k === "shell") {
    if (t.length > 42 || /`/.test(t) || /\n/.test(t)) {
      return k === "bash" || k === "shell" ? k : "execute";
    }
  }
  if (t.length > 48) return `${t.slice(0, 45).trimEnd()}…`;
  return t;
}

export function shortFailSummary(text, max = 160) {
  let s = stripAnsi(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "Tool failed";

  // Common Grok read_file transport failure on Windows paths
  if (/failed to deserialize response/i.test(s) || /deserialize response/i.test(s)) {
    return "Could not read file (tool transport error — try again or use shell)";
  }
  if (/ENOENT|no such file/i.test(s)) return "File not found";
  if (/permission denied|EACCES/i.test(s)) return "Permission denied";

  // Strip wrappers
  s = s.replace(/^Failed to read file:\s*/i, "");
  s = s.replace(/IO Error:\s*Internal error:\s*/i, "");
  s = s.replace(/^IO Error:\s*/i, "");
  s = s.replace(/^Error:\s*/i, "");
  // Drop surrounding quotes left from Debug formatting
  s = s.replace(/^"+|"+$/g, "").trim();

  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s || "Tool failed";
}

/**
 * Detect whether a string looks like a unified diff.
 * @param {string} text
 */
/**
 * Detect whether a string looks like a unified diff.
 * Requires strong headers (diff --git / ---+++ / @@) to avoid false positives
 * from shell logs, stack traces, or markdown with leading +/-.
 * @param {string} text
 */
export function looksLikeUnifiedDiff(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trimStart();
  if (/^diff --git /m.test(t)) return true;
  if (/^--- .+\n\+\+\+ /m.test(t)) return true;
  if (/^@@ -\d/.test(t) || /\n@@ -\d/.test(t)) return true;
  return false;
}

/**
 * Build a simple line-oriented diff from old/new text (Myers-lite LCS not needed —
 * fall back to per-line compare for short files; for long files show unified-ish blocks).
 * @param {string|null|undefined} oldText
 * @param {string|null|undefined} newText
 * @returns {{ kind: "ctx"|"add"|"del"|"hunk", text: string }[]}
 */
export function lineDiff(oldText, newText) {
  const a = oldText == null ? [] : String(oldText).split("\n");
  const b = newText == null ? [] : String(newText).split("\n");

  // New file
  if (oldText == null || oldText === "") {
    return b.map((text) => ({ kind: "add", text: text.length ? `+${text}` : "+" }));
  }
  // Deleted file
  if (newText == null || newText === "") {
    return a.map((text) => ({ kind: "del", text: text.length ? `-${text}` : "-" }));
  }

  // Simple LCS DP for reasonable sizes; otherwise dump both with markers
  const MAX = 800;
  if (a.length > MAX || b.length > MAX) {
    /** @type {{ kind: "ctx"|"add"|"del"|"hunk", text: string }[]} */
    const out = [{ kind: "hunk", text: `@@ large file · ${a.length} → ${b.length} lines @@` }];
    for (const text of a) out.push({ kind: "del", text: `-${text}` });
    for (const text of b) out.push({ kind: "add", text: `+${text}` });
    return out;
  }

  const n = a.length;
  const m = b.length;
  /** @type {Uint16Array[]} */
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  /** @type {{ kind: "ctx"|"add"|"del"|"hunk", text: string }[]} */
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "ctx", text: ` ${a[i]}` });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ kind: "del", text: `-${a[i]}` });
      i++;
    } else {
      lines.push({ kind: "add", text: `+${b[j]}` });
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: `-${a[i++]}` });
  }
  while (j < m) {
    lines.push({ kind: "add", text: `+${b[j++]}` });
  }
  return lines;
}

/**
 * Parse unified diff text into line objects.
 * @param {string} text
 * @returns {{ kind: "ctx"|"add"|"del"|"hunk", text: string }[]}
 */
export function parseUnifiedDiffLines(text) {
  const raw = String(text).replace(/\r\n/g, "\n").split("\n");
  /** @type {{ kind: "ctx"|"add"|"del"|"hunk", text: string }[]} */
  const lines = [];
  for (const line of raw) {
    if (
      line.startsWith("@@") ||
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ")
    ) {
      lines.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      lines.push({ kind: "del", text: line });
    } else if (line.startsWith("\\")) {
      lines.push({ kind: "hunk", text: line });
    } else {
      lines.push({ kind: "ctx", text: line.startsWith(" ") ? line : ` ${line}` });
    }
  }
  return lines;
}

/**
 * Unwrap ACP session/update notification or raw update object.
 * @param {unknown} msgOrUpdate
 * @returns {Record<string, unknown>|null}
 */
export function unwrapSessionUpdate(msgOrUpdate) {
  if (!msgOrUpdate || typeof msgOrUpdate !== "object") return null;
  const m = /** @type {Record<string, unknown>} */ (msgOrUpdate);
  // Full JSON-RPC notification
  if (m.params && typeof m.params === "object") {
    const p = /** @type {Record<string, unknown>} */ (m.params);
    const u = p.update || p.sessionUpdate || p;
    if (u && typeof u === "object") return /** @type {Record<string, unknown>} */ (u);
  }
  // Bare update / fields bag
  if (m.sessionUpdate || m.toolCallId || m.content || m.rawInput || m.raw_input) {
    return m;
  }
  if (m.update && typeof m.update === "object") {
    return /** @type {Record<string, unknown>} */ (m.update);
  }
  return m;
}

/**
 * Session update kind string (tool_call, plan, diff_review, …).
 * @param {unknown} msgOrUpdate
 * @returns {string}
 */
export function sessionUpdateKind(msgOrUpdate) {
  const u = unwrapSessionUpdate(msgOrUpdate);
  if (!u) return "";
  // Prefer ACP sessionUpdate / type only — `kind` is tool category (read/edit), not update type
  return String(u.sessionUpdate || u.type || "");
}

/**
 * Merge a tool_call_update into prior tool state without wiping body fields
 * when the update is sparse (status-only, empty content array, etc.).
 * @param {Record<string, unknown>} prev
 * @param {Record<string, unknown>} update
 * @returns {Record<string, unknown>}
 */
export function mergeToolUpdate(prev, update) {
  const p = prev && typeof prev === "object" ? prev : {};
  const u = update && typeof update === "object" ? update : {};
  const merged = { ...p, ...u };

  const keepIfEmpty = (key) => {
    const next = u[key];
    const prior = p[key];
    if (prior == null) return;
    if (next == null) {
      merged[key] = prior;
      return;
    }
    if (Array.isArray(next) && next.length === 0 && Array.isArray(prior) && prior.length) {
      merged[key] = prior;
      return;
    }
    if (
      typeof next === "object" &&
      !Array.isArray(next) &&
      Object.keys(next).length === 0 &&
      typeof prior === "object" &&
      prior &&
      Object.keys(/** @type {object} */ (prior)).length
    ) {
      merged[key] = prior;
    }
    if (typeof next === "string" && !next.trim() && typeof prior === "string" && prior.trim()) {
      merged[key] = prior;
    }
  };

  for (const key of [
    "content",
    "locations",
    "rawInput",
    "raw_input",
    "rawOutput",
    "raw_output",
    "input",
    "output",
  ]) {
    keepIfEmpty(key);
  }

  // Sparse non-empty content[] (status stubs without old/new) must not wipe diffs
  if (Array.isArray(u.content) && u.content.length > 0 && Array.isArray(p.content) && p.content.length) {
    const prevDiffs = extractDiffs(p);
    const nextDiffs = extractDiffs(u);
    if (prevDiffs.length > 0 && nextDiffs.length === 0) {
      merged.content = p.content;
    }
  }
  // Same for sparse rawInput that would drop extractable diffs
  if (u.rawInput != null && p.rawInput != null) {
    const prevDiffs = extractDiffs({ rawInput: p.rawInput });
    const nextDiffs = extractDiffs({ rawInput: u.rawInput });
    if (prevDiffs.length > 0 && nextDiffs.length === 0) {
      merged.rawInput = p.rawInput;
      if (merged.raw_input === u.raw_input) merged.raw_input = p.raw_input ?? p.rawInput;
    }
  }

  return merged;
}

/** Max lines rendered in a single diff block (avoid freezing the tab). */
export const MAX_DIFF_RENDER_LINES = 400;

/**
 * Extract structured diff payloads from a tool update / content item /
 * full session/update notification.
 * @param {unknown} update
 * @returns {{ path: string, oldText?: string|null, newText?: string|null, unified?: string }[]}
 */
export function extractDiffs(update) {
  /** @type {{ path: string, oldText?: string|null, newText?: string|null, unified?: string }[]} */
  const diffs = [];
  if (update == null) return diffs;

  // Accept full notifications
  const unwrapped = unwrapSessionUpdate(update) || update;

  const pushDiff = (obj) => {
    if (!obj || typeof obj !== "object") return;
    const o = /** @type {Record<string, unknown>} */ (obj);
    // Nested { type: "diff", path, oldText, newText } or flatten of acp Diff
    const path =
      o.path ||
      o.filePath ||
      o.file_path ||
      o.file ||
      o.filename ||
      (typeof o.diff === "object" && o.diff
        ? /** @type {Record<string, unknown>} */ (o.diff).path
        : null);
    const nested =
      o.type === "diff" && o.diff && typeof o.diff === "object"
        ? /** @type {Record<string, unknown>} */ (o.diff)
        : o;
    // Prefer ACP / Grok Build names only — avoid bare `old`/`new` false positives
    const oldText =
      nested.oldText ??
      nested.old_text ??
      nested.oldString ??
      nested.old_string ??
      null;
    const newText =
      nested.newText ??
      nested.new_text ??
      nested.newString ??
      nested.new_string ??
      null;
    const unified =
      typeof nested.diff === "string"
        ? nested.diff
        : typeof nested.patch === "string"
          ? nested.patch
          : typeof nested.unifiedDiff === "string"
            ? nested.unifiedDiff
            : null;

    if (path && (oldText != null || newText != null || unified)) {
      diffs.push({
        path: String(path),
        oldText: oldText == null ? null : String(oldText),
        newText: newText == null ? null : String(newText),
        unified: unified || undefined,
      });
      return;
    }
    if (unified && looksLikeUnifiedDiff(unified)) {
      const p = path ? String(path) : guessPathFromUnified(unified) || "diff";
      diffs.push({ path: p, unified });
    }
  };

  if (typeof unwrapped === "object") {
    const u = /** @type {Record<string, unknown>} */ (unwrapped);

    // Top-level path + old/new (incl. search_replace field names)
    if (
      (u.path || u.file_path || u.filePath) &&
      (u.oldText != null ||
        u.newText != null ||
        u.old_text != null ||
        u.new_text != null ||
        u.old_string != null ||
        u.new_string != null ||
        u.oldString != null ||
        u.newString != null)
    ) {
      pushDiff(u);
    }
    if (typeof u.diff === "string" && looksLikeUnifiedDiff(u.diff)) {
      diffs.push({
        path: String(u.path || guessPathFromUnified(u.diff) || "diff"),
        unified: u.diff,
      });
    }
    if (typeof u.patch === "string" && looksLikeUnifiedDiff(u.patch)) {
      diffs.push({
        path: String(u.path || guessPathFromUnified(u.patch) || "diff"),
        unified: u.patch,
      });
    }

    const content = u.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== "object") {
          if (typeof item === "string" && looksLikeUnifiedDiff(item)) {
            diffs.push({
              path: guessPathFromUnified(item) || "diff",
              unified: item,
            });
          }
          continue;
        }
        const it = /** @type {Record<string, unknown>} */ (item);
        // Always try pushDiff — no-ops when fields insufficient
        pushDiff(it);
        // Nested content block carrying text that is a diff
        if (it.type === "content" && it.content && typeof it.content === "object") {
          const c = /** @type {Record<string, unknown>} */ (it.content);
          if (typeof c.text === "string" && looksLikeUnifiedDiff(c.text)) {
            diffs.push({
              path: guessPathFromUnified(c.text) || "diff",
              unified: c.text,
            });
          }
        }
        if (typeof it.text === "string" && looksLikeUnifiedDiff(it.text)) {
          diffs.push({
            path: guessPathFromUnified(it.text) || "diff",
            unified: it.text,
          });
        }
      }
    } else if (typeof content === "string" && looksLikeUnifiedDiff(content)) {
      diffs.push({
        path: String(u.path || guessPathFromUnified(content) || "diff"),
        unified: content,
      });
    }

    // rawInput / rawOutput shapes (edit tools, search_replace, patches)
    for (const key of [
      "rawInput",
      "raw_input",
      "rawOutput",
      "raw_output",
      "input",
      "output",
      "fields",
    ]) {
      const v = u[key];
      if (v && typeof v === "object") {
        const r = /** @type {Record<string, unknown>} */ (v);
        if (r.fields && typeof r.fields === "object") {
          pushDiff(r.fields);
        }
        pushDiff(r);
      } else if (typeof v === "string" && looksLikeUnifiedDiff(v)) {
        diffs.push({ path: guessPathFromUnified(v) || "diff", unified: v });
      }
    }
  } else if (typeof unwrapped === "string" && looksLikeUnifiedDiff(unwrapped)) {
    diffs.push({
      path: guessPathFromUnified(unwrapped) || "diff",
      unified: unwrapped,
    });
  }

  // Dedupe by path + lengths (avoid holding full text twice in the key)
  const seen = new Set();
  return diffs.filter((d) => {
    const key = `${d.path}|u${(d.unified || "").length}|o${(d.oldText || "").length}|n${(d.newText || "").length}|${(d.oldText || "").slice(0, 24)}|${(d.newText || "").slice(0, 24)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {string} unified */
function guessPathFromUnified(unified) {
  const m =
    unified.match(/^\+\+\+ [ab]\/(.+)$/m) ||
    unified.match(/^--- [ab]\/(.+)$/m) ||
    unified.match(/^diff --git a\/.+ b\/(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Pull human-readable text snippets from tool content.
 * @param {unknown} update
 * @returns {string[]}
 */
export function extractTextSnippets(update) {
  /** @type {string[]} */
  const out = [];
  const unwrapped = unwrapSessionUpdate(update) || update;
  if (!unwrapped || typeof unwrapped !== "object") return out;
  const u = /** @type {Record<string, unknown>} */ (unwrapped);
  const content = u.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") {
        if (typeof item === "string" && item.trim() && !looksLikeUnifiedDiff(item)) {
          out.push(stripAnsi(item));
        }
        continue;
      }
      const it = /** @type {Record<string, unknown>} */ (item);
      if (it.type === "diff") continue;
      if (it.type === "terminal") {
        out.push(`[terminal ${it.terminalId || it.terminal_id || "?"}]`);
        continue;
      }
      if (it.type === "content" && it.content && typeof it.content === "object") {
        const c = /** @type {Record<string, unknown>} */ (it.content);
        if (typeof c.text === "string" && !looksLikeUnifiedDiff(c.text)) {
          out.push(stripAnsi(c.text));
        }
      } else if (typeof it.text === "string" && !looksLikeUnifiedDiff(it.text)) {
        out.push(stripAnsi(it.text));
      }
    }
  } else if (typeof content === "string" && !looksLikeUnifiedDiff(content)) {
    out.push(stripAnsi(content));
  }
  return out;
}

/**
 * @param {HTMLElement} container
 * @param {{ kind: "ctx"|"add"|"del"|"hunk", text: string }[]} lines
 */
export function renderDiffLines(container, lines) {
  container.classList.add("diff-view");
  container.replaceChildren();
  const frag = document.createDocumentFragment();
  const max = MAX_DIFF_RENDER_LINES;
  const slice =
    lines.length > max
      ? [
          ...lines.slice(0, Math.floor(max / 2)),
          {
            kind: /** @type {const} */ ("hunk"),
            text: `@@ … truncated ${lines.length - max} lines … @@`,
          },
          ...lines.slice(lines.length - Math.floor(max / 2)),
        ]
      : lines;
  for (const line of slice) {
    const el = document.createElement("div");
    el.className = `diff-line diff-${line.kind === "ctx" ? "ctx" : line.kind}`;
    el.textContent = stripAnsi(line.text);
    frag.appendChild(el);
  }
  container.appendChild(frag);
}

/**
 * Build a collapsible <details> section.
 * @param {string} label
 * @param {string|HTMLElement} body
 * @param {{ open?: boolean, mono?: boolean }} [opts]
 */
function detailsSection(label, body, opts = {}) {
  const d = document.createElement("details");
  d.className = "card-section";
  if (opts.open) d.open = true;
  const s = document.createElement("summary");
  s.textContent = label;
  d.appendChild(s);
  const bodyEl = document.createElement("div");
  bodyEl.className = opts.mono ? "card-section-body mono" : "card-section-body";
  if (typeof body === "string") {
    bodyEl.textContent = stripAnsi(body);
  } else {
    bodyEl.appendChild(body);
  }
  d.appendChild(bodyEl);
  return d;
}

/**
 * Render a path header + scrollable diff view.
 * @param {{ path: string, oldText?: string|null, newText?: string|null, unified?: string }} diff
 */
export function buildDiffBlock(diff) {
  const wrap = document.createElement("div");
  wrap.className = "diff-block";

  const header = document.createElement("div");
  header.className = "diff-path";
  header.textContent = diff.path || "file";
  wrap.appendChild(header);

  const view = document.createElement("div");
  let lines;
  if (diff.unified && looksLikeUnifiedDiff(diff.unified)) {
    lines = parseUnifiedDiffLines(diff.unified);
  } else if (diff.oldText != null || diff.newText != null) {
    lines = lineDiff(diff.oldText, diff.newText);
  } else if (diff.unified) {
    lines = parseUnifiedDiffLines(diff.unified);
  } else {
    lines = [{ kind: "hunk", text: "(empty diff)" }];
  }
  renderDiffLines(view, lines);
  wrap.appendChild(view);
  return wrap;
}

/**
 * Create or refresh a tool card DOM element.
 * @param {HTMLElement|null} existing
 * @param {Record<string, unknown>} update
 * @returns {HTMLElement}
 */
export function upsertToolCard(existing, update) {
  const u = unwrapSessionUpdate(update) || /** @type {Record<string, unknown>} */ (update);
  const toolCallId = String(
    u.toolCallId || u.tool_call_id || u.id || "",
  );
  const rawTitle = String(
    u.title ||
      u.toolName ||
      u.tool_name ||
      u.name ||
      u.kind ||
      "tool",
  );
  const kind = u.kind ? String(u.kind) : "";
  const title = compactToolTitle(rawTitle, kind);
  const status = normalizeStatus(u.status);
  const diffs = extractDiffs(u);
  const texts = extractTextSnippets(u);
  const locations = Array.isArray(u.locations) ? u.locations : [];
  let rawInput = u.rawInput ?? u.raw_input ?? u.input;
  const rawOutput = u.rawOutput ?? u.raw_output ?? u.output;
  // If title held the full shell command, keep it available under input when collapsed
  if (
    rawTitle !== title &&
    /^execute\b/i.test(rawTitle) &&
    (rawInput == null || rawInput === "")
  ) {
    rawInput = rawTitle.replace(/^execute\s*/i, "").replace(/^`|`$/g, "");
  }

  const failed = status === "failed";
  const completed = status === "completed";
  // Completed/failed: keep body collapsed (one-line chrome + optional expand)
  const quietDone = failed || completed;
  const card = existing || document.createElement("div");
  card.className = `card card-tool status-${status}${quietDone ? " is-quiet" : ""}${failed ? " is-failed-quiet" : ""}`;
  if (toolCallId) card.dataset.toolCallId = toolCallId;
  const prevStatus = card.dataset.toolStatus || "";
  card.dataset.toolStatus = status;

  // Quiet cards always force-collapse: shell dumps (Format-Table underlines,
  // long raw output) must not stay open after complete. While running, keep
  // user-opened sections across streaming updates only.
  const preserveOpen = !quietDone && prevStatus === status && prevStatus !== "";
  const wasOpen = new Set(
    preserveOpen
      ? [...card.querySelectorAll("details.card-section[open]")].map(
          (d) => d.querySelector("summary")?.textContent || "",
        )
      : [],
  );

  card.replaceChildren();

  const head = document.createElement("div");
  head.className = "card-head";

  const left = document.createElement("div");
  left.className = "card-head-main";

  const titleEl = document.createElement("span");
  titleEl.className = "card-title";
  titleEl.textContent = title;
  if (rawTitle !== title) titleEl.title = rawTitle;
  left.appendChild(titleEl);

  if (kind && kind !== title) {
    const kindEl = document.createElement("span");
    kindEl.className = "card-kind muted";
    kindEl.textContent = kind;
    left.appendChild(kindEl);
  }

  head.appendChild(left);

  const badge = document.createElement("span");
  badge.className = `badge badge-${status}`;
  badge.textContent = statusLabel(status);
  head.appendChild(badge);

  card.appendChild(head);

  // Path hint (useful on failed reads) — keep short
  if (locations.length) {
    const loc = document.createElement("div");
    loc.className = "card-locations muted mono";
    loc.textContent = locations
      .map((l) => {
        if (!l || typeof l !== "object") return String(l);
        const o = /** @type {Record<string, unknown>} */ (l);
        return o.line != null ? `${o.path}:${o.line}` : String(o.path || "");
      })
      .filter(Boolean)
      .join(" · ");
    if (loc.textContent) card.appendChild(loc);
  }

  // Failed: one-line summary only; details collapsed (no wall of error text)
  const joinedTexts = texts.length ? texts.join("\n") : "";
  if (failed) {
    const errBlob =
      joinedTexts ||
      (rawOutput != null && rawOutput !== ""
        ? typeof rawOutput === "string"
          ? rawOutput
          : prettyJson(rawOutput)
        : "") ||
      (rawInput != null ? prettyJson(rawInput) : "");
    const sum = document.createElement("div");
    sum.className = "card-fail-summary";
    sum.textContent = shortFailSummary(errBlob);
    card.appendChild(sum);

    if (errBlob && errBlob.trim() !== sum.textContent) {
      card.appendChild(
        detailsSection("details", errBlob, {
          open: wasOpen.has("details"),
          mono: true,
        }),
      );
    }
    // Quiet failed: no tool id spam (id is in dataset for debugging)
    return card;
  }

  // tool id only while running (collapsed cards stay one line)
  if (toolCallId && !quietDone) {
    const idEl = document.createElement("div");
    idEl.className = "card-id muted mono";
    idEl.textContent = toolCallId;
    card.appendChild(idEl);
  }

  // Diffs — collapsed when completed; open while running so live edits are visible
  if (diffs.length) {
    const diffsWrap = document.createElement("div");
    diffsWrap.className = "card-diffs";
    for (const d of diffs) {
      diffsWrap.appendChild(buildDiffBlock(d));
    }
    if (quietDone) {
      const det = document.createElement("details");
      det.className = "card-section";
      if (wasOpen.has("diff")) det.open = true;
      const sum = document.createElement("summary");
      sum.textContent = diffs.length === 1 ? "diff" : `diffs (${diffs.length})`;
      det.appendChild(sum);
      const body = document.createElement("div");
      body.className = "card-section-body";
      body.appendChild(diffsWrap);
      det.appendChild(body);
      card.appendChild(det);
    } else {
      card.appendChild(diffsWrap);
    }
  }

  // Text content — completed/failed: always collapsed; running: also collapsed
  // (user expands; avoids dumping shell walls into the transcript)
  if (texts.length) {
    const joined = texts.join("\n");
    const section = detailsSection(
      "output",
      joined,
      {
        open: wasOpen.has("output"),
        mono: true,
      },
    );
    card.appendChild(section);
  }

  // Skip raw input when it only duplicates the rendered diff (search_replace)
  const inputIsOnlyDiff =
    diffs.length > 0 &&
    rawInput &&
    typeof rawInput === "object" &&
    Object.keys(/** @type {object} */ (rawInput)).every((k) =>
      [
        "path",
        "file_path",
        "filePath",
        "old_string",
        "new_string",
        "oldString",
        "newString",
        "oldText",
        "newText",
        "old_text",
        "new_text",
        "diff",
        "patch",
      ].includes(k),
    );
  if (rawInput != null && rawInput !== "" && !inputIsOnlyDiff) {
    const inputStr = prettyJson(rawInput);
    const section = detailsSection("input", inputStr, {
      open: wasOpen.has("input"),
      mono: true,
    });
    card.appendChild(section);
  }

  // rawOutput: show as diff when unified; skip duplicate "raw output" if already have diffs from it
  if (rawOutput != null && rawOutput !== "" && !texts.length && !diffs.length) {
    const asStr =
      typeof rawOutput === "string" ? stripAnsi(rawOutput) : prettyJson(rawOutput);
    if (looksLikeUnifiedDiff(asStr)) {
      const block = buildDiffBlock({
        path: guessPathFromUnified(asStr) || "output",
        unified: asStr,
      });
      if (quietDone) {
        const det = document.createElement("details");
        det.className = "card-section";
        if (wasOpen.has("diff")) det.open = true;
        const sum = document.createElement("summary");
        sum.textContent = "diff";
        det.appendChild(sum);
        const body = document.createElement("div");
        body.className = "card-section-body";
        body.appendChild(block);
        det.appendChild(body);
        card.appendChild(det);
      } else {
        card.appendChild(block);
      }
    } else {
      card.appendChild(
        detailsSection("output", asStr, {
          open: wasOpen.has("output"),
          mono: true,
        }),
      );
    }
  } else if (
    rawOutput != null &&
    rawOutput !== "" &&
    texts.length &&
    !diffs.length
  ) {
    // Non-diff raw alongside text snippets
    card.appendChild(
      detailsSection("raw output", prettyJson(rawOutput), {
        open: wasOpen.has("raw output"),
        mono: true,
      }),
    );
  }
  // If diffs already rendered from rawOutput, do not add redundant raw section

  // Fallback: unknown shape with extra fields
  const known = new Set([
    "sessionUpdate",
    "type",
    "kind",
    "toolCallId",
    "tool_call_id",
    "id",
    "title",
    "status",
    "content",
    "locations",
    "rawInput",
    "raw_input",
    "rawOutput",
    "raw_output",
    "input",
    "output",
    "toolName",
    "tool_name",
    "name",
    "path",
    "file_path",
    "filePath",
    "oldText",
    "newText",
    "old_text",
    "new_text",
    "old_string",
    "new_string",
    "oldString",
    "newString",
    "diff",
    "patch",
    "fields",
  ]);
  const extra = {};
  let hasExtra = false;
  for (const [k, v] of Object.entries(u)) {
    if (!known.has(k) && v != null && v !== "") {
      extra[k] = v;
      hasExtra = true;
    }
  }
  if (hasExtra && !diffs.length && !texts.length && rawInput == null && rawOutput == null) {
    card.appendChild(
      detailsSection("details", prettyJson(extra), {
        open: wasOpen.has("details"),
        mono: true,
      }),
    );
  }

  // Compact path-only edit tools (locations present, no body)
  if (
    !diffs.length &&
    !texts.length &&
    rawInput == null &&
    rawOutput == null &&
    !hasExtra &&
    locations.length
  ) {
    // head + locations already enough
  }

  return card;
}

/**
 * Build / replace a plan card.
 * @param {HTMLElement|null} existing
 * @param {Record<string, unknown>} update
 * @returns {HTMLElement}
 */
export function upsertPlanCard(existing, update) {
  const u = unwrapSessionUpdate(update) || /** @type {Record<string, unknown>} */ (update);
  const entries = Array.isArray(u.entries)
    ? u.entries
    : Array.isArray(u.plan)
      ? u.plan
      : Array.isArray(u.steps)
        ? u.steps
        : [];

  const card = existing || document.createElement("div");
  card.className = "card card-plan";
  card.replaceChildren();

  const head = document.createElement("div");
  head.className = "card-head";
  const title = document.createElement("span");
  title.className = "card-title";
  title.textContent = "Plan";
  head.appendChild(title);

  const count = document.createElement("span");
  count.className = "badge badge-plan";
  const done = entries.filter(
    (e) => e && normalizeStatus(e.status) === "completed",
  ).length;
  count.textContent =
    entries.length > 0 ? `${done}/${entries.length}` : "0";
  head.appendChild(count);
  card.appendChild(head);

  const list = document.createElement("ul");
  list.className = "plan-list";

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "plan-item muted";
    li.textContent =
      u && typeof u === "object"
        ? prettyJson(u).slice(0, 500) || "(empty plan)"
        : "(empty plan)";
    list.appendChild(li);
  } else {
    for (const entry of entries) {
      const li = document.createElement("li");
      if (!entry || typeof entry !== "object") {
        li.className = "plan-item";
        li.textContent = String(entry);
        list.appendChild(li);
        continue;
      }
      const e = /** @type {Record<string, unknown>} */ (entry);
      const st = normalizeStatus(e.status);
      li.className = `plan-item plan-${st}`;

      const mark = document.createElement("span");
      mark.className = "plan-check";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent =
        st === "completed" ? "✓" : st === "running" ? "●" : st === "failed" ? "✕" : "○";
      li.appendChild(mark);

      const body = document.createElement("div");
      body.className = "plan-body";

      const text = document.createElement("div");
      text.className = "plan-text";
      text.textContent = String(e.content || e.title || e.text || prettyJson(e));
      body.appendChild(text);

      if (e.priority) {
        const pr = document.createElement("span");
        pr.className = `plan-priority prio-${String(e.priority).toLowerCase()}`;
        pr.textContent = String(e.priority);
        body.appendChild(pr);
      }

      li.appendChild(body);
      list.appendChild(li);
    }
  }

  card.appendChild(list);
  return card;
}

/**
 * Append a card element into the transcript.
 * Caller owns stick-to-bottom scrolling (see app.js scrollTranscript).
 * @param {HTMLElement} transcript
 * @param {HTMLElement} card
 */
export function mountCard(transcript, card) {
  if (!card.isConnected) {
    transcript.appendChild(card);
  }
  return card;
}
