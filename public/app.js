import { upsertToolCard, upsertPlanCard } from "./cards.js";

const $ = (id) => document.getElementById(id);

const els = {
  cwd: $("cwd"),
  meta: $("meta"),
  status: $("status"),
  statusText: $("status-text"),
  sessionLabel: $("session-label"),
  transcript: $("transcript"),
  emptyState: $("empty-state"),
  prompt: $("prompt"),
  hint: $("hint"),
  btnNew: $("btn-new"),
  btnSend: $("btn-send"),
  btnCancel: $("btn-cancel"),
  btnStop: $("btn-stop"),
  alwaysApprove: $("always-approve"),
  sidebar: $("sidebar"),
  btnSidebarOpen: $("btn-sidebar-open"),
  btnSidebarClose: $("btn-sidebar-close"),
  sidebarBackdrop: $("sidebar-backdrop"),
  sessionList: $("session-list"),
};

/** @type {string|null} */
let activeTabId = null;

/**
 * Per-tab client state.
 * @typedef {{
 *   tabId: string,
 *   sessionId: string|null,
 *   cwd: string,
 *   title: string|null,
 *   alive: boolean,
 *   createdAt: number,
 *   lastActiveAt: number,
 *   draft: string,
 *   stream: EventSource|null,
 *   liveAgentBubble: HTMLElement|null,
 *   liveThoughtBubble: HTMLElement|null,
 *   park: DocumentFragment|null,
 *   toolCards: Map<string, HTMLElement>,
 *   toolState: Map<string, Record<string, unknown>>,
 *   planCard: HTMLElement|null,
 *   sending: boolean,
 *   cancelHttpInflight: boolean,
 * }} TabState
 * @type {Map<string, TabState>}
 */
const tabStates = new Map();

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.statusText.textContent = text;
}

function activeState() {
  return activeTabId ? tabStates.get(activeTabId) || null : null;
}

function shortId(id) {
  return id ? String(id).slice(0, 8) : "";
}

function cwdBase(cwd) {
  if (!cwd) return "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function displayTitle(st) {
  if (st.title) return st.title;
  const base = cwdBase(st.cwd);
  return base ? base : `Session ${shortId(st.tabId)}`;
}

function updateSessionLabel(st) {
  if (!st) {
    els.sessionLabel.textContent = "No session";
    return;
  }
  const sid = st.sessionId ? shortId(st.sessionId) : shortId(st.tabId);
  const title = displayTitle(st);
  els.sessionLabel.textContent = st.alive
    ? `${title} · ${sid}…`
    : `${title} · stopped`;
}

function markTranscriptFilled() {
  els.transcript.classList.add("has-messages");
}

function syncTranscriptEmptyClass(host = els.transcript) {
  const has =
    host === els.transcript
      ? [...host.children].some((c) => c !== els.emptyState)
      : host.childNodes.length > 0;
  if (host === els.transcript) {
    els.transcript.classList.toggle("has-messages", has);
  }
}

function scrollTranscript() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/** Message host for a tab: live transcript if active, else parked fragment. */
function messageHost(st) {
  if (st.tabId === activeTabId) return els.transcript;
  if (!st.park) st.park = document.createDocumentFragment();
  return st.park;
}

function appendBubble(st, kind, text, { role } = {}) {
  const host = messageHost(st);
  const div = document.createElement("div");
  div.className = `bubble ${kind}`;
  if (role) {
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = role;
    div.appendChild(r);
  }
  if (text) div.appendChild(document.createTextNode(text));
  host.appendChild(div);
  if (st.tabId === activeTabId) {
    markTranscriptFilled();
    scrollTranscript();
  }
  return div;
}

function appendToLive(st, kind, chunk) {
  // parentNode works for both live DOM and parked DocumentFragment
  // (isConnected is false while parked in a fragment).
  if (kind === "thought") {
    if (!st.liveThoughtBubble || !st.liveThoughtBubble.parentNode) {
      st.liveThoughtBubble = appendBubble(st, "thought", "", { role: "thinking" });
    }
    st.liveThoughtBubble.appendChild(document.createTextNode(chunk));
  } else {
    if (!st.liveAgentBubble || !st.liveAgentBubble.parentNode) {
      st.liveAgentBubble = appendBubble(st, "agent", "", { role: "greg" });
    }
    st.liveAgentBubble.appendChild(document.createTextNode(chunk));
  }
  if (st.tabId === activeTabId) scrollTranscript();
}

function resetLive(st) {
  if (!st) return;
  st.liveAgentBubble = null;
  st.liveThoughtBubble = null;
}

/** Park active transcript messages into tab.park (keeps empty-state in place). */
function parkActiveTranscript(st) {
  if (!st || st.tabId !== activeTabId) return;
  const frag = document.createDocumentFragment();
  for (const child of [...els.transcript.children]) {
    if (child === els.emptyState) continue;
    frag.appendChild(child);
  }
  st.park = frag;
  // live bubbles remain connected inside park
  els.transcript.classList.remove("has-messages");
}

/** Restore parked messages into the live transcript. */
function restoreTranscript(st) {
  // Clear current messages (keep empty-state)
  for (const child of [...els.transcript.children]) {
    if (child !== els.emptyState) child.remove();
  }
  if (st?.park) {
    els.transcript.appendChild(st.park);
    st.park = null;
  }
  syncTranscriptEmptyClass();
  scrollTranscript();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || res.statusText || "Request failed";
    const err = new Error(msg);
    err.data = data;
    throw err;
  }
  return data;
}

async function loadMeta() {
  try {
    const meta = await api("/api/meta");
    if (!els.cwd.value) els.cwd.value = meta.defaultCwd || "";
    els.meta.innerHTML = `
      <div><strong>greg</strong> v${escapeHtml(meta.version)}</div>
      <div class="muted">bin: ${escapeHtml(meta.grokBin)}</div>
      <div class="muted">${escapeHtml(meta.platform)}</div>
    `;
  } catch (e) {
    els.meta.textContent = e.message;
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ensureTabState(meta) {
  let st = tabStates.get(meta.tabId);
  if (!st) {
    st = {
      tabId: meta.tabId,
      sessionId: meta.sessionId || null,
      cwd: meta.cwd || "",
      title: meta.title || null,
      alive: meta.alive !== false,
      createdAt: meta.createdAt || Date.now(),
      lastActiveAt: meta.lastActiveAt || Date.now(),
      draft: "",
      stream: null,
      liveAgentBubble: null,
      liveThoughtBubble: null,
      park: null,
      toolCards: new Map(),
      toolState: new Map(),
      planCard: null,
      sending: false,
      cancelHttpInflight: false,
    };
    tabStates.set(meta.tabId, st);
  } else {
    if (meta.sessionId != null) st.sessionId = meta.sessionId;
    if (meta.cwd != null) st.cwd = meta.cwd;
    if (meta.title !== undefined) st.title = meta.title;
    if (meta.alive !== undefined) st.alive = meta.alive;
    if (meta.lastActiveAt != null) st.lastActiveAt = meta.lastActiveAt;
    if (!st.toolCards) st.toolCards = new Map();
    if (!st.toolState) st.toolState = new Map();
    if (st.sending === undefined) st.sending = false;
    if (st.cancelHttpInflight === undefined) st.cancelHttpInflight = false;
  }
  return st;
}

/**
 * Append or refresh a card in the tab's message host (live transcript or park).
 * @param {TabState} st
 * @param {HTMLElement} card
 * @param {boolean} isNew
 */
function mountTabCard(st, card, isNew) {
  const host = messageHost(st);
  if (isNew || !card.parentNode) {
    host.appendChild(card);
  }
  if (st.tabId === activeTabId) {
    markTranscriptFilled();
    scrollTranscript();
  }
  return card;
}

function renderSessionList() {
  if (!els.sessionList) return;
  const items = [...tabStates.values()].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );
  els.sessionList.innerHTML = "";

  for (const st of items) {
    const row = document.createElement("div");
    row.className = "session-item";
    if (st.tabId === activeTabId) row.classList.add("active");
    if (!st.alive) row.classList.add("dead");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "session-pick";
    pick.title = st.cwd || st.tabId;
    if (st.sending) row.classList.add("busy");
    const busyTag = st.sending ? " · running" : "";
    pick.innerHTML = `
      <span class="session-title">${escapeHtml(displayTitle(st))}</span>
      <span class="session-sub">${escapeHtml(cwdBase(st.cwd) || shortId(st.tabId))}${st.alive ? "" : " · dead"}${busyTag} · ${escapeHtml(shortId(st.tabId))}</span>
    `;
    pick.addEventListener("click", () => {
      switchToTab(st.tabId);
      closeSidebar();
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn icon session-close";
    close.title = "Stop session";
    close.setAttribute("aria-label", "Stop session");
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      stopSession(st.tabId);
    });

    row.appendChild(pick);
    row.appendChild(close);
    els.sessionList.appendChild(row);
  }
}

function connectStream(st) {
  if (!st || st.stream) return;

  const stream = new EventSource(
    `/api/stream?tabId=${encodeURIComponent(st.tabId)}`,
  );
  st.stream = stream;
  const boundTabId = st.tabId;

  stream.addEventListener("hello", () => {
    /* connected */
  });
  stream.addEventListener("acp", (ev) => {
    try {
      handleAcp(boundTabId, JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  stream.addEventListener("acp-request", (ev) => {
    try {
      handleAcpRequest(boundTabId, JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  stream.addEventListener("stderr", (ev) => {
    try {
      const { text } = JSON.parse(ev.data);
      const tab = tabStates.get(boundTabId);
      if (tab && text?.trim()) appendBubble(tab, "system", text.trim());
    } catch {
      /* ignore */
    }
  });
  stream.addEventListener("error", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const tab = tabStates.get(boundTabId);
      if (!tab) return;
      appendBubble(tab, "system", data.message || "Agent error");
      if (boundTabId === activeTabId) setStatus("error", "Error");
    } catch {
      /* EventSource network error also fires "error" without data */
    }
  });
  stream.addEventListener("exit", (ev) => {
    try {
      const info = JSON.parse(ev.data);
      const tab = tabStates.get(boundTabId);
      if (!tab) return;
      tab.alive = false;
      tab.lastActiveAt = Date.now();
      appendBubble(tab, "system", `Agent exited (code=${info.code})`);
      if (tab.stream) {
        tab.stream.close();
        tab.stream = null;
      }
      if (boundTabId === activeTabId) {
        setStatus("idle", "Disconnected");
        setComposerEnabled(false);
        setStopEnabled(false);
        updateSessionLabel(tab);
      }
      renderSessionList();
    } catch {
      /* ignore */
    }
  });
}

function closeStream(st) {
  if (st?.stream) {
    st.stream.close();
    st.stream = null;
  }
}

function handleAcp(tabId, msg) {
  const st = tabStates.get(tabId);
  if (!st) return;

  if (msg.method !== "session/update" && msg.method !== "x.ai/session/update") {
    return;
  }
  const params = msg.params || {};
  const update = params.update || params.sessionUpdate || params;
  const kind = update.sessionUpdate || update.type || update.kind;

  if (kind === "agent_message_chunk" || kind === "agent_message") {
    const chunk =
      update.content?.text ||
      update.text ||
      update.message?.text ||
      (typeof update.content === "string" ? update.content : "") ||
      "";
    if (chunk) appendToLive(st, "agent", chunk);
    return;
  }
  if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    const chunk =
      update.content?.text ||
      update.text ||
      (typeof update.content === "string" ? update.content : "") ||
      "";
    if (chunk) appendToLive(st, "thought", chunk);
    return;
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const toolCallId = String(
      update.toolCallId || update.tool_call_id || update.id || "",
    );
    const key = toolCallId || `__anon_${st.toolCards.size}`;
    const prev = st.toolState.get(key) || {};
    // Merge partial tool_call_update into stored state
    const merged = { ...prev, ...update };
    // Prefer non-empty content arrays; keep previous if update omits body
    if (
      update.content == null &&
      prev.content != null
    ) {
      merged.content = prev.content;
    }
    st.toolState.set(key, merged);

    const existing = st.toolCards.get(key) || null;
    const card = upsertToolCard(existing, merged);
    st.toolCards.set(key, card);
    mountTabCard(st, card, !existing);
    return;
  }
  if (kind === "plan") {
    const existing = st.planCard;
    const card = upsertPlanCard(existing, update);
    st.planCard = card;
    mountTabCard(st, card, !existing);
  }
}

// ── Permission cards ─────────────────────────────────────────

/**
 * Normalize options from ACP permission params.
 * @param {object} params
 * @returns {{ optionId: string, name: string, kind: string }[]}
 */
function extractPermissionOptions(params) {
  const raw = params?.options;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Deny", kind: "reject_once" },
    ];
  }
  return raw.map((o, i) => {
    const optionId =
      o.optionId || o.option_id || o.id || o.kind || `option-${i}`;
    const kind = String(o.kind || optionId || "").toLowerCase();
    const name =
      o.name ||
      o.label ||
      o.title ||
      humanizeOptionId(String(optionId));
    return { optionId: String(optionId), name: String(name), kind };
  });
}

function humanizeOptionId(id) {
  return id
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Pull a short human summary from permission / tool params.
 * @param {string} method
 * @param {object} params
 */
function summarizePermission(method, params = {}) {
  const toolCall =
    params.toolCall || params.tool_call || params.tool || null;
  const fields = toolCall?.fields || toolCall || {};
  const rawInput =
    fields.rawInput ||
    fields.raw_input ||
    params.rawInput ||
    params.raw_input ||
    null;

  const title =
    fields.title ||
    toolCall?.title ||
    params.title ||
    params.description ||
    null;

  const kind =
    fields.kind ||
    toolCall?.kind ||
    params.kind ||
    null;

  const toolCallId =
    toolCall?.toolCallId ||
    toolCall?.tool_call_id ||
    fields.toolCallId ||
    params.toolCallId ||
    null;

  /** @type {string[]} */
  const detailLines = [];
  let headline = title || shortMethodLabel(method);

  if (rawInput && typeof rawInput === "object") {
    const cmd =
      rawInput.command ||
      rawInput.cmd ||
      (typeof rawInput.shell === "string" ? rawInput.shell : null);
    const path =
      rawInput.path ||
      rawInput.file_path ||
      rawInput.filePath ||
      rawInput.filepath ||
      rawInput.target ||
      null;
    const desc =
      typeof rawInput.description === "string" ? rawInput.description : null;

    if (desc && !title) headline = desc;
    if (cmd) detailLines.push(String(cmd));
    else if (path) detailLines.push(String(path));
    else {
      const keys = Object.keys(rawInput).slice(0, 4);
      if (keys.length) {
        const peek = keys
          .map((k) => {
            const v = rawInput[k];
            const s =
              typeof v === "string"
                ? v
                : v == null
                  ? ""
                  : JSON.stringify(v);
            return `${k}: ${truncate(s, 80)}`;
          })
          .join("\n");
        if (peek.trim()) detailLines.push(peek);
      }
    }
  } else if (typeof rawInput === "string" && rawInput.trim()) {
    detailLines.push(rawInput.trim());
  }

  if (!detailLines.length) {
    const path = params.path || params.file_path || params.filePath;
    const cmd = params.command || params.cmd;
    if (cmd) detailLines.push(String(cmd));
    else if (path) detailLines.push(String(path));
  }

  return {
    headline: String(headline || "Permission required"),
    detail: detailLines.join("\n").slice(0, 600),
    kind: kind ? String(kind) : null,
    toolCallId: toolCallId ? String(toolCallId) : null,
    method: method || "request",
  };
}

function shortMethodLabel(method) {
  if (!method) return "Permission";
  if (method.includes("request_permission")) return "Tool permission";
  if (method.includes("ask_user")) return "Question";
  if (method.includes("exit_plan")) return "Plan approval";
  const parts = method.split("/");
  return parts[parts.length - 1] || method;
}

function truncate(s, n) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isAllowKind(kind, optionId) {
  const s = `${kind} ${optionId}`.toLowerCase();
  return /allow|approve|yes|accept/.test(s) && !/reject|deny|cancel|no\b/.test(s);
}

function isDenyKind(kind, optionId) {
  const s = `${kind} ${optionId}`.toLowerCase();
  return /reject|deny|cancel|no\b/.test(s);
}

/**
 * @param {string} tabId
 * @param {object} msg ACP request { id, method, params }
 */
async function handleAcpRequest(tabId, msg) {
  const st = tabStates.get(tabId);
  if (!st) return;

  const method = msg.method || "";
  const params = msg.params || {};
  const summary = summarizePermission(method, params);
  const options = extractPermissionOptions(params);
  const auto = els.alwaysApprove.checked && msg.id != null;

  if (auto) {
    const allow =
      options.find((o) => isAllowKind(o.kind, o.optionId)) || options[0];
    const card = renderPermissionCard(st, {
      summary,
      options: [],
      auto: true,
      pending: true,
    });
    try {
      await api("/api/permission", {
        method: "POST",
        body: JSON.stringify({
          tabId,
          id: msg.id,
          result: {
            outcome: { outcome: "selected", optionId: allow.optionId },
          },
        }),
      });
      resolvePermissionCard(card, {
        label: `Auto-approved · ${allow.name}`,
        state: "auto-done",
      });
    } catch (e) {
      resolvePermissionCard(card, {
        label: `Auto-approve failed: ${e.message}`,
        state: "failed",
      });
    }
    return;
  }

  const card = renderPermissionCard(st, {
    summary,
    options,
    auto: false,
    pending: true,
  });

  if (msg.id == null) {
    resolvePermissionCard(card, {
      label: "No request id — cannot respond",
      state: "failed",
    });
    return;
  }

  const actions = card.querySelector(".perm-actions");
  if (!actions) return;

  for (const opt of options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm";
    if (isAllowKind(opt.kind, opt.optionId)) btn.classList.add("allow");
    else if (isDenyKind(opt.kind, opt.optionId)) btn.classList.add("danger");
    btn.textContent = opt.name;
    btn.dataset.optionId = opt.optionId;
    btn.addEventListener("click", async () => {
      await answerPermission(tabId, card, msg.id, opt);
    });
    actions.appendChild(btn);
  }
}

/**
 * @param {TabState} st
 * @param {{ summary: ReturnType<typeof summarizePermission>, options: ReturnType<typeof extractPermissionOptions>, auto: boolean, pending: boolean }} opts
 */
function renderPermissionCard(st, { summary, options: _options, auto }) {
  const card = document.createElement("div");
  card.className = `bubble perm-card${auto ? " auto" : ""}`;
  card.setAttribute("role", "group");
  card.setAttribute(
    "aria-label",
    auto ? "Auto-approved permission" : "Permission request",
  );

  const head = document.createElement("div");
  head.className = "perm-head";

  const badge = document.createElement("span");
  badge.className = "perm-badge";
  badge.textContent = auto ? "Auto-approved" : "Permission";
  head.appendChild(badge);

  const methodEl = document.createElement("span");
  methodEl.className = "perm-method";
  methodEl.textContent = summary.method;
  head.appendChild(methodEl);
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "perm-body";

  const title = document.createElement("p");
  title.className = "perm-title";
  title.textContent = summary.headline;
  body.appendChild(title);

  if (summary.detail) {
    const detail = document.createElement("pre");
    detail.className = "perm-summary";
    detail.textContent = summary.detail;
    body.appendChild(detail);
  }

  if (summary.kind || summary.toolCallId) {
    const meta = document.createElement("div");
    meta.className = "perm-meta";
    if (summary.kind) {
      const k = document.createElement("span");
      k.textContent = summary.kind;
      meta.appendChild(k);
    }
    if (summary.toolCallId) {
      const id = document.createElement("span");
      id.textContent = truncate(summary.toolCallId, 24);
      meta.appendChild(id);
    }
    body.appendChild(meta);
  }

  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "perm-actions";
  card.appendChild(actions);

  const outcome = document.createElement("div");
  outcome.className = "perm-outcome";
  outcome.innerHTML = `<span class="outcome-dot" aria-hidden="true"></span><span class="outcome-text"></span>`;
  card.appendChild(outcome);

  messageHost(st).appendChild(card);
  if (st.tabId === activeTabId) {
    markTranscriptFilled();
    scrollTranscript();
  }
  return card;
}

/**
 * @param {HTMLElement} card
 * @param {{ label: string, state: 'allowed'|'denied'|'auto-done'|'failed' }} result
 */
function resolvePermissionCard(card, { label, state }) {
  card.classList.add("resolved", state);
  card.classList.remove("auto");
  if (state === "auto-done") card.classList.add("auto");

  const actions = card.querySelector(".perm-actions");
  if (actions) {
    for (const btn of actions.querySelectorAll("button")) {
      btn.disabled = true;
    }
  }

  const text = card.querySelector(".outcome-text");
  if (text) text.textContent = label;

  const badge = card.querySelector(".perm-badge");
  if (badge && state === "auto-done") badge.textContent = "Auto-approved";
  else if (badge && state === "allowed") badge.textContent = "Allowed";
  else if (badge && state === "denied") badge.textContent = "Denied";
  else if (badge && state === "failed") badge.textContent = "Failed";
}

/**
 * @param {string} tabId
 * @param {HTMLElement} card
 * @param {string|number} requestId
 * @param {{ optionId: string, name: string, kind: string }} opt
 */
async function answerPermission(tabId, card, requestId, opt) {
  const actions = card.querySelector(".perm-actions");
  if (actions) {
    for (const btn of actions.querySelectorAll("button")) {
      btn.disabled = true;
    }
  }

  const deny = isDenyKind(opt.kind, opt.optionId);
  const allow = isAllowKind(opt.kind, opt.optionId);

  try {
    await api("/api/permission", {
      method: "POST",
      body: JSON.stringify({
        tabId,
        id: requestId,
        result: {
          outcome: { outcome: "selected", optionId: opt.optionId },
        },
      }),
    });
    resolvePermissionCard(card, {
      label: opt.name,
      state: deny ? "denied" : allow ? "allowed" : "allowed",
    });
  } catch (e) {
    resolvePermissionCard(card, {
      label: `Failed: ${e.message}`,
      state: "failed",
    });
  }
}

// ── Session / composer ───────────────────────────────────────

/**
 * Refresh composer/cancel/status from the *active* tab only.
 * Background tabs keep their own `sending` flags independently.
 */
function refreshActiveComposer() {
  const st = activeState();
  if (!st) {
    els.prompt.disabled = true;
    els.btnSend.disabled = true;
    setCancelVisible(false);
    els.hint.textContent = "Create a session to start";
    return;
  }

  const on = st.alive;
  const busy = Boolean(st.sending);
  els.prompt.disabled = !on;
  els.btnSend.disabled = !on || busy;
  setCancelVisible(on && busy);
  if (els.btnCancel) {
    // Allow re-notify while busy; only disable during cancel HTTP round-trip
    els.btnCancel.disabled = !on || !busy || st.cancelHttpInflight;
  }

  if (!on) {
    els.hint.textContent =
      "Session stopped — pick a live tab or start a new one";
  } else if (busy) {
    els.hint.textContent =
      "Running… Cancel or Ctrl+. to stop the turn (Stop session forces kill)";
  } else {
    els.hint.textContent =
      "Enter to send · ⌘/Ctrl+Enter · Ctrl+. cancel · Esc focus";
  }
}

/** @deprecated use refreshActiveComposer — kept for call sites that pass bool */
function setComposerEnabled(on) {
  if (!on) {
    els.prompt.disabled = true;
    els.btnSend.disabled = true;
    setCancelVisible(false);
    const st = activeState();
    els.hint.textContent = st
      ? "Session stopped — pick a live tab or start a new one"
      : "Create a session to start";
    return;
  }
  refreshActiveComposer();
}

function setStopEnabled(on) {
  if (els.btnStop) els.btnStop.disabled = !on;
}

/** @param {boolean} visible */
function setCancelVisible(visible) {
  if (!els.btnCancel) return;
  els.btnCancel.hidden = !visible;
}

/**
 * Switch UI to another tab.
 * @param {string} tabId
 */
function switchToTab(tabId) {
  if (tabId === activeTabId) return;
  const next = tabStates.get(tabId);
  if (!next) return;

  const prev = activeState();
  if (prev) {
    prev.draft = els.prompt.value;
    parkActiveTranscript(prev);
  }

  activeTabId = tabId;
  restoreTranscript(next);
  els.prompt.value = next.draft || "";
  if (next.cwd) els.cwd.value = next.cwd;

  if (next.alive) connectStream(next);
  updateSessionLabel(next);
  setStopEnabled(next.alive);
  refreshActiveComposer();
  if (next.alive) {
    if (next.sending) setStatus("busy", "Running…");
    else setStatus("ready", "Ready");
  } else {
    setStatus("idle", "Disconnected");
  }
  renderSessionList();
  if (next.alive) els.prompt.focus();
}

async function newSession() {
  setStatus("busy", "Starting agent…");
  setComposerEnabled(false);
  setStopEnabled(false);
  closeSidebar();

  // Park current tab; do not stop it
  const prev = activeState();
  if (prev) {
    prev.draft = els.prompt.value;
    parkActiveTranscript(prev);
  }

  // Temporarily clear view while spawning
  for (const child of [...els.transcript.children]) {
    if (child !== els.emptyState) child.remove();
  }
  els.transcript.classList.remove("has-messages");
  activeTabId = null;
  els.prompt.value = "";

  try {
    const data = await api("/api/session/new", {
      method: "POST",
      body: JSON.stringify({
        cwd: els.cwd.value.trim() || undefined,
        alwaysApprove: els.alwaysApprove.checked,
      }),
    });

    const st = ensureTabState({
      tabId: data.tabId,
      sessionId: data.sessionId,
      cwd: data.cwd,
      title: data.title || null,
      alive: true,
      createdAt: data.createdAt,
      lastActiveAt: data.lastActiveAt,
    });
    st.draft = "";
    st.park = null;
    resetLive(st);

    activeTabId = st.tabId;
    appendBubble(st, "system", "Spawning grok agent stdio…");
    appendBubble(st, "system", `Session ready · ${data.cwd}`);

    connectStream(st);
    updateSessionLabel(st);
    setStatus("ready", "Ready");
    setComposerEnabled(true);
    setStopEnabled(true);
    renderSessionList();
    els.prompt.focus();
  } catch (e) {
    setStatus("error", "Failed");
    const hint = e.data?.hint ? `\n${e.data.hint}` : "";
    const msg = `${e.message}${hint}`;

    // Restore previous tab if any
    if (prev) {
      activeTabId = prev.tabId;
      restoreTranscript(prev);
      els.prompt.value = prev.draft || "";
      appendBubble(prev, "system", msg);
      setComposerEnabled(prev.alive);
      setStopEnabled(prev.alive);
      setStatus(prev.alive ? "ready" : "error", prev.alive ? "Ready" : "Failed");
      updateSessionLabel(prev);
    } else {
      const div = document.createElement("div");
      div.className = "bubble system";
      div.textContent = msg;
      els.transcript.appendChild(div);
      markTranscriptFilled();
      setComposerEnabled(false);
      setStopEnabled(false);
      updateSessionLabel(null);
    }
    renderSessionList();
  }
}

/**
 * Stop one session by tabId (sidebar × or topbar Stop for active).
 * @param {string} [tabId]
 */
async function stopSession(tabId = activeTabId) {
  if (!tabId) return;
  const st = tabStates.get(tabId);
  if (!st) return;

  if (tabId === activeTabId && els.btnStop) els.btnStop.disabled = true;

  try {
    await api("/api/session/stop", {
      method: "POST",
      body: JSON.stringify({ tabId }),
    });
  } catch (e) {
    if (tabId === activeTabId) {
      appendBubble(st, "system", `Stop failed: ${e.message}`);
      setStopEnabled(true);
    }
    return;
  }

  closeStream(st);
  tabStates.delete(tabId);

  if (activeTabId === tabId) {
    activeTabId = null;
    const remaining = [...tabStates.values()].sort(
      (a, b) => b.lastActiveAt - a.lastActiveAt,
    );
    if (remaining.length) {
      // Clear current messages before switch
      for (const child of [...els.transcript.children]) {
        if (child !== els.emptyState) child.remove();
      }
      switchToTab(remaining[0].tabId);
    } else {
      for (const child of [...els.transcript.children]) {
        if (child !== els.emptyState) child.remove();
      }
      els.transcript.classList.remove("has-messages");
      els.prompt.value = "";
      updateSessionLabel(null);
      setStatus("idle", "Idle");
      setComposerEnabled(false);
      setStopEnabled(false);
      renderSessionList();
    }
  } else {
    renderSessionList();
  }
}

async function sendPrompt() {
  const text = els.prompt.value.trim();
  const st = activeState();
  if (!text || !st || !st.alive || st.sending) return;

  els.prompt.value = "";
  st.draft = "";
  resetLive(st);
  appendBubble(st, "user", text, { role: "you" });
  st.sending = true;
  st.cancelHttpInflight = false;
  if (st.tabId === activeTabId) {
    setStatus("busy", "Running…");
    refreshActiveComposer();
  }
  renderSessionList();

  if (!st.title) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    st.title =
      oneLine.length <= 40 ? oneLine : oneLine.slice(0, 40).trimEnd() + "…";
    updateSessionLabel(st);
  }
  st.lastActiveAt = Date.now();
  renderSessionList();

  try {
    const data = await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ tabId: st.tabId, text }),
    });
    if (data.title) st.title = data.title;
    if (data.lastActiveAt) st.lastActiveAt = data.lastActiveAt;
    updateSessionLabel(st);

    const cancelled = data.result?.stopReason === "cancelled";
    if (cancelled) {
      // Always record on this tab's transcript (may be parked)
      appendBubble(st, "system", "Turn cancelled");
    }
    if (st.tabId === activeTabId) {
      if (cancelled) setStatus("ready", "Cancelled");
      else if (st.alive) setStatus("ready", "Ready");
    }
  } catch (e) {
    appendBubble(st, "system", e.message);
    if (st.tabId === activeTabId) setStatus("error", "Error");
  } finally {
    st.sending = false;
    st.cancelHttpInflight = false;
    renderSessionList();
    if (st.tabId === activeTabId) {
      refreshActiveComposer();
      if (st.alive) els.prompt.focus();
    }
  }
}

/**
 * Interrupt the in-flight agent turn (session stays open).
 * Targets the tab that is actually sending when called without tabId.
 * @param {string} [tabId]
 */
async function cancelTurn(tabId) {
  let targetId = tabId;
  if (!targetId) {
    const active = activeState();
    if (active?.sending) targetId = active.tabId;
    else {
      // Prefer explicit busy tab if active is idle
      for (const t of tabStates.values()) {
        if (t.sending && t.alive) {
          targetId = t.tabId;
          break;
        }
      }
    }
  }
  if (!targetId) return;
  const st = tabStates.get(targetId);
  if (!st?.alive || !st.sending) return;
  if (st.cancelHttpInflight) return;

  st.cancelHttpInflight = true;
  if (targetId === activeTabId) refreshActiveComposer();

  try {
    const data = await api("/api/cancel", {
      method: "POST",
      body: JSON.stringify({ tabId: targetId, reason: "user" }),
    });
    if (targetId === activeTabId) {
      if (data.hadPending === false) {
        setStatus("busy", "Cancel sent (no pending turn on agent)");
      } else {
        setStatus("busy", "Cancelling…");
      }
    }
  } catch (e) {
    appendBubble(st, "system", `Cancel failed: ${e.message}`);
    if (targetId === activeTabId) setStatus("error", "Cancel failed");
  } finally {
    st.cancelHttpInflight = false;
    if (targetId === activeTabId) refreshActiveComposer();
  }
}

async function hydrateSessions() {
  try {
    const data = await api("/api/sessions");
    const list = data.tabs || [];
    for (const meta of list) {
      const st = ensureTabState(meta);
      if (st.alive) connectStream(st);
    }
    renderSessionList();
    if (!activeTabId && list.length) {
      switchToTab(list[0].tabId);
    }
  } catch {
    /* first paint without list is fine */
  }
}

// ── Sidebar (mobile) ─────────────────────────────────────────

function openSidebar() {
  document.body.classList.add("sidebar-open");
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = false;
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
}

function toggleSidebar() {
  if (document.body.classList.contains("sidebar-open")) closeSidebar();
  else openSidebar();
}

// ── Events ───────────────────────────────────────────────────

els.btnNew.addEventListener("click", () => newSession());
els.btnSend.addEventListener("click", () => sendPrompt());
if (els.btnCancel) {
  els.btnCancel.addEventListener("click", () => cancelTurn(activeTabId));
}
if (els.btnStop) {
  els.btnStop.addEventListener("click", () => stopSession(activeTabId));
}

els.prompt.addEventListener("keydown", (e) => {
  const modEnter = e.key === "Enter" && (e.metaKey || e.ctrlKey);
  const plainEnter =
    e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey;
  if (modEnter || plainEnter) {
    e.preventDefault();
    sendPrompt();
  }
});

els.prompt.addEventListener("input", () => {
  const st = activeState();
  if (st) st.draft = els.prompt.value;
});

document.addEventListener("keydown", (e) => {
  // Ctrl+. — cancel in-flight turn (Codex-style interrupt)
  if (e.key === "." && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const active = activeState();
    const busy =
      (active?.sending && active.alive) ||
      [...tabStates.values()].some((t) => t.sending && t.alive);
    if (busy) {
      e.preventDefault();
      // Prefer active tab if it is the one running
      cancelTurn(active?.sending ? active.tabId : undefined);
    }
    return;
  }

  if (e.key !== "Escape") return;
  if (document.body.classList.contains("sidebar-open")) {
    closeSidebar();
    e.preventDefault();
    return;
  }
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    active !== els.prompt &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "BUTTON")
  ) {
    active.blur();
    e.preventDefault();
    return;
  }
  if (!els.prompt.disabled) {
    els.prompt.focus();
    e.preventDefault();
  }
});

if (els.btnSidebarOpen) {
  els.btnSidebarOpen.addEventListener("click", () => openSidebar());
}
if (els.btnSidebarClose) {
  els.btnSidebarClose.addEventListener("click", () => closeSidebar());
}
if (els.sidebarBackdrop) {
  els.sidebarBackdrop.addEventListener("click", () => closeSidebar());
}

loadMeta();
hydrateSessions();
setStatus("idle", "Idle");
setStopEnabled(false);
setComposerEnabled(false);
renderSessionList();
