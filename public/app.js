import {
  upsertToolCard,
  upsertPlanCard,
  mergeToolUpdate,
} from "./cards.js";
import { setMarkdownBody, isDecorativeOnlyMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);

const els = {
  cwd: $("cwd"),
  cwdLabel: $("cwd-label"),
  btnBrowseCwd: $("btn-browse-cwd"),
  composerProject: $("composer-project"),
  composerProjectLabel: $("composer-project-label"),
  emptyCards: $("empty-cards"),
  folderPicker: $("folder-picker"),
  folderPickerBackdrop: $("folder-picker-backdrop"),
  folderPickerClose: $("folder-picker-close"),
  folderPickerUp: $("folder-picker-up"),
  folderPickerHome: $("folder-picker-home"),
  folderPickerNew: $("folder-picker-new"),
  folderPickerDrive: $("folder-picker-drive"),
  folderPickerCrumbs: $("folder-picker-crumbs"),
  folderPickerList: $("folder-picker-list"),
  folderPickerStatus: $("folder-picker-status"),
  folderPickerCancel: $("folder-picker-cancel"),
  folderPickerSelect: $("folder-picker-select"),
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
  model: $("model"),
  effort: $("effort"),
  defaultCwd: $("default-cwd"),
  sidebar: $("sidebar"),
  btnSidebarOpen: $("btn-sidebar-open"),
  btnSidebarClose: $("btn-sidebar-close"),
  sidebarBackdrop: $("sidebar-backdrop"),
  sessionList: $("session-list"),
  historyList: $("history-list"),
  recentsList: $("recents-list"),
  btnFiles: $("btn-files"),
  btnFilesClose: $("btn-files-close"),
  btnFilesRefresh: $("btn-files-refresh"),
  filesPanel: $("files-panel"),
  filesTree: $("files-tree"),
  filesRootLabel: $("files-root-label"),
  filesPreview: $("files-preview"),
  filesPreviewPath: $("files-preview-path"),
  filesPreviewMeta: $("files-preview-meta"),
  btnImportGrok: $("btn-import-grok"),
  importGrok: $("import-grok"),
  importGrokBackdrop: $("import-grok-backdrop"),
  importGrokClose: $("import-grok-close"),
  importGrokList: $("import-grok-list"),
  importGrokStatus: $("import-grok-status"),
  importGrokRefresh: $("import-grok-refresh"),
  importGrokDone: $("import-grok-done"),
  composer: document.querySelector(".composer"),
};

/** When set, main pane is a read-only history replay (not a live tab). */
/** @type {string|null} */
let historyViewId = null;
/** Monotonic generation to ignore stale openHistory responses. */
let historyLoadGen = 0;
/** Throttle disk history refresh (not every prompt). */
let historyRefreshTimer = null;
/**
 * While resuming Earlier chat B, show B under Active immediately and keep it
 * out of Earlier — avoids the flash where A is still Active and A+B both in Earlier.
 * @type {string|null}
 */
let pendingResumeId = null;
/** @type {{ title?: string|null, cwd?: string, cwdBase?: string }|null} */
let pendingResumeMeta = null;

/** @type {string|null} */
let activeTabId = null;
/** Guard double-click New session / recents. */
let creatingSession = false;

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

/** Keep hidden #cwd and visible label in sync. */
function setWorkspacePath(path, { openFiles = false } = {}) {
  const p = (path || "").trim();
  if (els.cwd) els.cwd.value = p;
  const short = p ? cwdBase(p) || p : "";
  if (els.cwdLabel) {
    if (p) {
      // Short name in UI; full path on hover
      els.cwdLabel.textContent = short;
      els.cwdLabel.classList.add("has-path");
      els.cwdLabel.title = p;
    } else {
      els.cwdLabel.textContent = "Choose project…";
      els.cwdLabel.classList.remove("has-path");
      els.cwdLabel.title = "";
    }
  }
  if (els.composerProjectLabel) {
    els.composerProjectLabel.textContent = short || "Choose project";
  }
  if (els.composerProject) {
    els.composerProject.title = p
      ? `${p} — click to change`
      : "Choose project folder";
    els.composerProject.classList.toggle("has-path", Boolean(p));
  }
  if (els.btnBrowseCwd) {
    els.btnBrowseCwd.title = p
      ? `${p} — click to change`
      : "Browse for a project folder";
  }
  if (openFiles && p) {
    setFilesPanelOpen(true);
    void refreshFilesTree();
  } else if (filesPanelOpen) {
    syncFilesPanelToWorkspace();
  }
}

/* ── Workspace folder picker ─────────────────────────────── */

/** @type {string} */
let pickerPath = "";
/** @type {string|null} */
let pickerParent = null;
/** @type {string} */
let pickerHome = "";
/** @type {{ id: string, path: string, label: string, system?: boolean }[]} */
let pickerRoots = [];
/** @type {string} */
let pickerDefaultRoot = "";
/** @type {number} */
let pickerLoadGen = 0;
/** @type {boolean} */
let pickerRootsLoaded = false;

function isFolderPickerOpen() {
  return Boolean(els.folderPicker && !els.folderPicker.hidden);
}

/** Reject filesystem root as a workspace (too broad). */
function isSelectableWorkspacePath(p) {
  const s = String(p || "").trim();
  if (!s) return false;
  if (s === "/" || s === "\\") return false;
  // Bare drive root e.g. C:\ is OK as workspace on Windows; user may want it
  return true;
}

function openFolderPicker(startPath) {
  if (!els.folderPicker) return;
  els.folderPicker.hidden = false;
  const start =
    (startPath || els.cwd?.value || settings.defaultCwd || "").trim() || "";
  void ensurePickerRoots().then(() => {
    // No path yet → open on system drive (not Home)
    const initial = start || pickerDefaultRoot || undefined;
    return loadFolderPicker(initial);
  });
  queueMicrotask(() => {
    els.folderPickerSelect?.focus();
  });
}

function closeFolderPicker() {
  if (!els.folderPicker) return;
  els.folderPicker.hidden = true;
  if (els.folderPickerStatus) {
    els.folderPickerStatus.textContent = "";
    els.folderPickerStatus.classList.remove("is-error");
  }
}

async function ensurePickerRoots() {
  if (pickerRootsLoaded) return;
  try {
    const data = await api("/api/fs/roots");
    pickerRoots = data.roots || [];
    pickerHome = data.home || pickerHome;
    pickerDefaultRoot =
      data.defaultRoot ||
      pickerRoots.find((r) => r.system)?.path ||
      pickerRoots[0]?.path ||
      "";
    pickerRootsLoaded = true;
    populateDriveSelect();
  } catch {
    pickerRoots = [];
    pickerDefaultRoot = "";
    pickerRootsLoaded = true;
    populateDriveSelect();
  }
}

function populateDriveSelect(preferPath = null) {
  if (!els.folderPickerDrive) return;
  const prev = preferPath != null ? preferPath : els.folderPickerDrive.value;
  els.folderPickerDrive.innerHTML = "";
  // No empty "Drive…" placeholder — only real drives, system first
  for (const r of pickerRoots) {
    const opt = document.createElement("option");
    opt.value = r.path;
    opt.textContent = r.label || r.path;
    if (r.system) opt.dataset.system = "1";
    els.folderPickerDrive.appendChild(opt);
  }
  const options = [...els.folderPickerDrive.options];
  if (
    prev &&
    options.some((o) => o.value === prev)
  ) {
    els.folderPickerDrive.value = prev;
  } else if (pickerDefaultRoot && options.some((o) => o.value === pickerDefaultRoot)) {
    els.folderPickerDrive.value = pickerDefaultRoot;
  } else if (options.length) {
    els.folderPickerDrive.selectedIndex = 0;
  }
}

/**
 * @param {{ label: string, path: string }[]} crumbs
 * @param {string} currentPath
 */
function renderFolderCrumbs(crumbs, currentPath) {
  if (!els.folderPickerCrumbs) return;
  els.folderPickerCrumbs.innerHTML = "";
  const list = Array.isArray(crumbs) ? crumbs : [];
  if (!list.length) {
    const span = document.createElement("span");
    span.className = "folder-crumb-current";
    span.textContent = currentPath || "";
    els.folderPickerCrumbs.appendChild(span);
    return;
  }
  list.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "folder-crumb-sep";
      sep.textContent = "/";
      sep.setAttribute("aria-hidden", "true");
      els.folderPickerCrumbs.appendChild(sep);
    }
    const isLast = i === list.length - 1;
    if (isLast) {
      const cur = document.createElement("span");
      cur.className = "folder-crumb-current";
      cur.textContent = c.label;
      cur.title = c.path;
      els.folderPickerCrumbs.appendChild(cur);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "folder-crumb";
      btn.textContent = c.label;
      btn.title = c.path;
      btn.addEventListener("click", () => {
        void loadFolderPicker(c.path);
      });
      els.folderPickerCrumbs.appendChild(btn);
    }
  });
}

/**
 * Sync drive dropdown to current path (longest matching root).
 * @param {string} absPath
 */
function syncDriveSelect(absPath) {
  if (!els.folderPickerDrive || !pickerRoots.length) return;
  const p = String(absPath || "");
  let best = "";
  let bestLen = -1;
  for (const r of pickerRoots) {
    const rp = r.path;
    if (!rp) continue;
    let match = false;
    if (rp === "/") {
      match = p.startsWith("/");
    } else if (p === rp || p.startsWith(rp + "/") || p.startsWith(rp + "\\")) {
      match = true;
    } else if (
      /^[A-Za-z]:\\?$/.test(rp) &&
      p.toLowerCase().startsWith(rp.slice(0, 2).toLowerCase())
    ) {
      match = true;
    }
    if (match && rp.length > bestLen) {
      best = rp;
      bestLen = rp.length;
    }
  }
  if (best && [...els.folderPickerDrive.options].some((o) => o.value === best)) {
    els.folderPickerDrive.value = best;
  } else if (pickerDefaultRoot) {
    els.folderPickerDrive.value = pickerDefaultRoot;
  }
}

/**
 * @param {string} [path]
 */
async function loadFolderPicker(path) {
  if (!els.folderPickerList) return;
  const gen = ++pickerLoadGen;
  els.folderPickerList.innerHTML =
    '<div class="folder-picker-empty muted">Loading…</div>';
  if (els.folderPickerStatus) {
    els.folderPickerStatus.textContent = "";
    els.folderPickerStatus.classList.remove("is-error");
  }
  if (els.folderPickerUp) els.folderPickerUp.disabled = true;
  if (els.folderPickerSelect) els.folderPickerSelect.disabled = true;
  if (els.folderPickerNew) els.folderPickerNew.disabled = true;

  try {
    const q = new URLSearchParams();
    if (path) q.set("path", path);
    const data = await api(`/api/fs/dirs?${q}`);
    if (gen !== pickerLoadGen) return;

    pickerPath = data.path || "";
    pickerParent = data.parent ?? null;
    pickerHome = data.home || pickerHome;

    renderFolderCrumbs(data.breadcrumbs || [], pickerPath);
    syncDriveSelect(pickerPath);

    if (els.folderPickerUp) {
      // At / we can still jump via drive select; Up disabled only when no parent
      els.folderPickerUp.disabled = !pickerParent;
    }
    const selectable = isSelectableWorkspacePath(pickerPath);
    if (els.folderPickerSelect) els.folderPickerSelect.disabled = !selectable;
    if (els.folderPickerNew) {
      // Allow new folder even under / (rare)
      els.folderPickerNew.disabled = !pickerPath;
    }

    els.folderPickerList.innerHTML = "";
    const entries = data.entries || [];
    if (!entries.length) {
      els.folderPickerList.innerHTML =
        '<div class="folder-picker-empty muted">No subfolders — create one or use “Use this folder”.</div>';
    } else {
      for (const ent of entries) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "folder-picker-item";
        btn.setAttribute("role", "option");
        btn.dataset.path = ent.path;
        btn.innerHTML = `
          <span class="folder-picker-item-icon" aria-hidden="true">📁</span>
          <span class="folder-picker-item-name"></span>
        `;
        btn.querySelector(".folder-picker-item-name").textContent = ent.name;
        btn.title = ent.path;
        btn.addEventListener("click", () => {
          void loadFolderPicker(ent.path);
        });
        els.folderPickerList.appendChild(btn);
      }
    }
    if (data.truncated && els.folderPickerStatus) {
      els.folderPickerStatus.textContent = "Listing truncated (too many folders).";
    }
    if (!selectable && els.folderPickerStatus && !els.folderPickerStatus.textContent) {
      els.folderPickerStatus.textContent =
        "Open a project folder (cannot use filesystem root as workspace).";
    }
  } catch (e) {
    if (gen !== pickerLoadGen) return;
    els.folderPickerList.innerHTML = "";
    if (els.folderPickerCrumbs) els.folderPickerCrumbs.innerHTML = "";
    if (els.folderPickerStatus) {
      els.folderPickerStatus.textContent = e.message || "Failed to list folder";
      els.folderPickerStatus.classList.add("is-error");
    }
    if (els.folderPickerSelect) els.folderPickerSelect.disabled = true;
    if (els.folderPickerNew) els.folderPickerNew.disabled = true;
  }
}

function confirmFolderPicker() {
  if (!isSelectableWorkspacePath(pickerPath)) return;
  setWorkspacePath(pickerPath, { openFiles: true });
  closeFolderPicker();
}

async function createFolderInPicker() {
  if (!pickerPath) return;
  const name = window.prompt("New folder name:");
  if (name == null) return;
  const trimmed = String(name).trim();
  if (!trimmed) return;
  if (els.folderPickerStatus) {
    els.folderPickerStatus.textContent = "Creating…";
    els.folderPickerStatus.classList.remove("is-error");
  }
  try {
    const data = await api("/api/fs/mkdir", {
      method: "POST",
      body: JSON.stringify({ path: pickerPath, name: trimmed }),
    });
    // Enter the new folder so the user can confirm it as workspace
    await loadFolderPicker(data.path || joinPath(pickerPath, trimmed));
    if (els.folderPickerStatus) {
      els.folderPickerStatus.textContent = `Created “${trimmed}”`;
    }
  } catch (e) {
    if (els.folderPickerStatus) {
      els.folderPickerStatus.textContent = e.message || "Failed to create folder";
      els.folderPickerStatus.classList.add("is-error");
    }
  }
}

/** Simple path join for fallback after mkdir (POSIX-first; server returns abs path). */
function joinPath(parent, name) {
  const p = String(parent || "");
  if (p.endsWith("/") || p.endsWith("\\")) return p + name;
  if (/^[A-Za-z]:\\/.test(p)) return p + "\\" + name;
  return p + "/" + name;
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

/** Remove all transcript children except the empty-state placeholder. */
function clearTranscriptMessages() {
  if (!els.transcript) return;
  for (const child of [...els.transcript.children]) {
    if (child !== els.emptyState) child.remove();
  }
  els.transcript.classList.remove("has-messages");
}

/**
 * Hide transcript while swapping chats so active+history never stack for a frame.
 * @param {{ clear?: boolean }} [opts] clear — also drop live nodes (default true)
 */
function beginTranscriptSwap(opts = {}) {
  if (!els.transcript) return;
  els.transcript.classList.add("is-swapping");
  els.transcript.setAttribute("aria-busy", "true");
  if (opts.clear !== false) clearTranscriptMessages();
}

function endTranscriptSwap() {
  if (!els.transcript) return;
  els.transcript.classList.remove("is-swapping");
  els.transcript.removeAttribute("aria-busy");
}

/**
 * Build messages off-DOM, then replace transcript in one append (no partial paint).
 * @param {Array<{ role?: string, text?: string, meta?: object }>} messages
 */
function paintHistoryMessages(messages) {
  const frag = document.createDocumentFragment();
  for (const m of messages || []) {
    renderHistoryMessage(m, frag);
  }
  clearTranscriptMessages();
  els.transcript.appendChild(frag);
  if ((messages || []).length) markTranscriptFilled();
  else syncTranscriptEmptyClass();
  scrollTranscript({ force: true });
}

/**
 * Pin transcript to latest only while the user is already near the bottom.
 * Scrolling up detaches; scrolling back to the end re-attaches.
 */
let stickTranscriptToBottom = true;
const TRANSCRIPT_STICK_PX = 96;

function isTranscriptNearBottom(el = els.transcript) {
  if (!el) return true;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  return gap <= TRANSCRIPT_STICK_PX;
}

function updateTranscriptStickFromScroll() {
  stickTranscriptToBottom = isTranscriptNearBottom();
}

/**
 * @param {{ force?: boolean }} [opts]
 * force — always jump (user send, switch chat, load history)
 */
function scrollTranscript(opts = {}) {
  const force = opts.force === true;
  if (!force && !stickTranscriptToBottom) return;
  const el = els.transcript;
  if (!el) return;
  // Instant pin — CSS smooth fights continuous streaming updates
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = "auto";
  el.scrollTop = el.scrollHeight;
  el.style.scrollBehavior = prev;
  stickTranscriptToBottom = true;
}

/** Message host for a tab: live transcript if active, else parked fragment. */
function messageHost(st) {
  if (st.tabId === activeTabId) return els.transcript;
  if (!st.park) st.park = document.createDocumentFragment();
  return st.park;
}

/**
 * Collapsed-by-default thinking bubble (<details>).
 * @param {string} [text]
 * @param {{ open?: boolean }} [opts]
 * @returns {HTMLDetailsElement}
 */
function createThoughtBubble(text = "", opts = {}) {
  const det = document.createElement("details");
  det.className = "bubble thought";
  det.open = opts.open === true;
  const sum = document.createElement("summary");
  sum.className = "thought-summary";
  const role = document.createElement("span");
  role.className = "role";
  role.textContent = "thinking";
  sum.appendChild(role);
  const hint = document.createElement("span");
  hint.className = "thought-hint muted";
  hint.textContent = "hidden";
  sum.appendChild(hint);
  det.appendChild(sum);
  const body = document.createElement("div");
  body.className = "thought-body";
  if (text) body.textContent = text;
  det.appendChild(body);
  return det;
}

function appendBubble(st, kind, text, { role } = {}) {
  const host = messageHost(st);
  /** @type {HTMLElement} */
  let div;
  if (kind === "thought") {
    div = createThoughtBubble(text || "", { open: false });
  } else {
    div = document.createElement("div");
    div.className = `bubble ${kind}`;
    if (role) {
      const r = document.createElement("span");
      r.className = "role";
      r.textContent = role;
      div.appendChild(r);
    }
    // Agent (+ user) get structured markdown body; system/tool stay plain
    if (kind === "agent" || kind === "user") {
      const body = document.createElement("div");
      body.className = "md-body";
      div.appendChild(body);
      div._rawText = text || "";
      if (text) setMarkdownBody(body, text, { streaming: false });
    } else if (text) {
      div.appendChild(document.createTextNode(text));
    }
  }
  host.appendChild(div);
  if (st.tabId === activeTabId) {
    markTranscriptFilled();
    scrollTranscript();
  }
  return div;
}

/**
 * @param {HTMLElement|null|undefined} bubble
 * @param {string} chunk
 * @param {{ streaming?: boolean }} [opts]
 */
function appendMarkdownChunk(bubble, chunk, opts = {}) {
  if (!bubble || !chunk) return;
  bubble._rawText = (bubble._rawText || "") + chunk;
  let body = bubble.querySelector(".md-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "md-body";
    bubble.appendChild(body);
  }
  const streaming = opts.streaming !== false;
  if (streaming) {
    if (bubble._mdTimer) return;
    bubble._mdTimer = setTimeout(() => {
      bubble._mdTimer = null;
      setMarkdownBody(body, bubble._rawText || "", { streaming: true });
    }, 48);
  } else {
    if (bubble._mdTimer) {
      clearTimeout(bubble._mdTimer);
      bubble._mdTimer = null;
    }
    setMarkdownBody(body, bubble._rawText || "", { streaming: false });
  }
}

/** @param {HTMLElement|null|undefined} bubble */
function finalizeMarkdownBubble(bubble) {
  if (!bubble) return;
  if (bubble._mdTimer) {
    clearTimeout(bubble._mdTimer);
    bubble._mdTimer = null;
  }
  const raw = bubble._rawText;
  if (raw == null) return;
  const body = bubble.querySelector(".md-body");
  if (body) setMarkdownBody(body, raw, { streaming: false });
}

/**
 * Hollow agent bubbles (empty / only `---`) keep a full-width border so the
 * top+bottom edges look like two large horizontal lines in the chat.
 * @param {HTMLElement|null|undefined} bubble
 * @returns {boolean} true if removed
 */
function discardEmptyAgentBubble(bubble) {
  if (!bubble) return false;
  if (!isDecorativeOnlyMarkdown(bubble._rawText)) return false;
  if (bubble._mdTimer) {
    clearTimeout(bubble._mdTimer);
    bubble._mdTimer = null;
  }
  bubble.remove();
  return true;
}

function appendToLive(st, kind, chunk) {
  // parentNode works for both live DOM and parked DocumentFragment
  // (isConnected is false while parked in a fragment).
  if (kind === "thought") {
    if (!String(chunk ?? "").trim()) return;
    if (!st.liveThoughtBubble || !st.liveThoughtBubble.parentNode) {
      st.liveThoughtBubble = appendBubble(st, "thought", "", { role: "thinking" });
    }
    // Stay collapsed by default; user can expand. Brief open while streaming
    // only if they already opened it — never auto-spam thinking text.
    const body =
      st.liveThoughtBubble.querySelector(".thought-body") || st.liveThoughtBubble;
    body.appendChild(document.createTextNode(chunk));
  } else {
    // Do not open a new agent card for whitespace / bare `---` alone — that
    // paints an empty bordered bubble (two thick horizontal lines).
    if (!st.liveAgentBubble || !st.liveAgentBubble.parentNode) {
      if (isDecorativeOnlyMarkdown(chunk)) return;
      st.liveAgentBubble = appendBubble(st, "agent", "", { role: "greg" });
    }
    appendMarkdownChunk(st.liveAgentBubble, chunk, { streaming: true });
  }
  if (st.tabId === activeTabId) scrollTranscript();
}

function resetLive(st) {
  if (!st) return;
  // Finish any in-flight markdown so tool cards appear after final content
  finalizeMarkdownBubble(st.liveAgentBubble);
  discardEmptyAgentBubble(st.liveAgentBubble);
  // Drop empty thinking shells; collapse non-empty ones
  if (st.liveThoughtBubble) {
    const body =
      st.liveThoughtBubble.querySelector(".thought-body") || st.liveThoughtBubble;
    const text = (body.textContent || "").trim();
    if (!text) st.liveThoughtBubble.remove();
    else if ("open" in st.liveThoughtBubble) st.liveThoughtBubble.open = false;
  }
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
  // Replace park wholesale — never merge with a leftover fragment (that
  // stacked two chats when switching active ↔ earlier).
  st.park = frag;
  els.transcript.classList.remove("has-messages");
}

/** Restore parked messages into the live transcript. */
function restoreTranscript(st) {
  clearTranscriptMessages();
  if (st?.park) {
    els.transcript.appendChild(st.park);
    st.park = null;
  }
  syncTranscriptEmptyClass();
  scrollTranscript({ force: true });
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

/** @type {{ alwaysApprove: boolean, model: string|null, effort: string|null, defaultCwd: string|null, theme: string }} */
let settings = {
  alwaysApprove: false,
  model: "grok-4.5",
  effort: "high",
  defaultCwd: null,
  theme: "dark",
};

/** @type {{ id: string, name: string, default?: boolean }[]} */
let availableModels = [{ id: "grok-4.5", name: "Grok 4.5", default: true }];

let settingsSaveTimer = null;
let settingsLoaded = false;
/** Monotonic save generation — ignore stale PUT responses. */
let settingsSaveGen = 0;
/** @type {Promise<void>|null} */
let settingsSaveChain = null;

/**
 * Rebuild model <select> from availableModels, preserving current value if possible.
 * @param {string|null} [prefer]
 */
function populateModelSelect(prefer = null) {
  if (!els.model || els.model.tagName !== "SELECT") return;
  const current = prefer != null ? prefer : els.model.value;
  els.model.innerHTML = "";

  // Prefer live list, but always offer grok-4.5 as the product default
  const list =
    availableModels.length > 0
      ? availableModels
      : [{ id: "grok-4.5", name: "Grok 4.5", default: true }];

  const seen = new Set();
  for (const m of list) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    const opt = document.createElement("option");
    opt.value = m.id;
    const isDefault = m.default || m.id === "grok-4.5";
    // Compact labels in composer; keep default marker only for non-default extras
    opt.textContent =
      m.id === "grok-4.5" ? "Grok 4.5" : m.name || m.id;
    opt.title = m.description || m.id;
    els.model.appendChild(opt);
  }
  if (!seen.has("grok-4.5")) {
    const opt = document.createElement("option");
    opt.value = "grok-4.5";
    opt.textContent = "Grok 4.5";
    els.model.appendChild(opt);
    seen.add("grok-4.5");
  }

  const pick =
    current && seen.has(current)
      ? current
      : seen.has("grok-4.5")
        ? "grok-4.5"
        : [...seen][0] || "grok-4.5";
  els.model.value = pick;
}

async function loadMeta() {
  try {
    const meta = await api("/api/meta");
    if (Array.isArray(meta.models) && meta.models.length) {
      availableModels = meta.models;
    }
    populateModelSelect(meta.settings?.model || "");
    if (meta.settings) applySettingsToUi(meta.settings);
    if (!els.cwd?.value) {
      const initial =
        (meta.settings && meta.settings.defaultCwd) || meta.defaultCwd || "";
      if (initial) setWorkspacePath(initial);
    } else {
      setWorkspacePath(els.cwd.value);
    }
    const modelHint =
      meta.defaultModel || availableModels.find((m) => m.default)?.id || "grok-4.5";
    els.meta.innerHTML = `
      <div class="muted">v${escapeHtml(meta.version)} · ${escapeHtml(modelHint)}</div>
    `;
  } catch (e) {
    els.meta.textContent = e.message;
    populateModelSelect();
  }
}

/**
 * @param {{ alwaysApprove?: boolean, model?: string|null, effort?: string|null, defaultCwd?: string|null, theme?: string }} s
 */
function applySettingsToUi(s) {
  const effortRaw = s.effort;
  const effort =
    effortRaw === "low" || effortRaw === "medium" || effortRaw === "high"
      ? effortRaw
      : "high";
  settings = {
    alwaysApprove: s.alwaysApprove === true,
    model: (s.model && String(s.model).trim()) || "grok-4.5",
    effort,
    defaultCwd: s.defaultCwd ?? null,
    theme: s.theme || "dark",
  };
  if (els.alwaysApprove) els.alwaysApprove.checked = settings.alwaysApprove;
  if (els.model) {
    populateModelSelect(settings.model);
  }
  if (els.effort) {
    els.effort.value = settings.effort;
  }
  if (els.defaultCwd) els.defaultCwd.value = settings.defaultCwd || "";
  settingsLoaded = true;
}

function readSettingsFromUi() {
  const effortRaw = (els.effort?.value || "").trim().toLowerCase();
  const effort =
    effortRaw === "low" || effortRaw === "medium" || effortRaw === "high"
      ? effortRaw
      : "high";
  return {
    alwaysApprove: els.alwaysApprove?.checked === true,
    model: (els.model?.value || "").trim() || "grok-4.5",
    effort,
    // Field removed from slim UI — keep stored value if present
    defaultCwd: els.defaultCwd
      ? (els.defaultCwd.value || "").trim() || null
      : settings.defaultCwd ?? null,
    theme: settings.theme || "dark",
  };
}

/** Values sent on session/new — always concrete model + effort. */
function sessionModelEffortFromUi() {
  const s = readSettingsFromUi();
  return {
    model: s.model || "grok-4.5",
    effort: s.effort || "high",
  };
}

function scheduleSettingsSave() {
  if (!settingsLoaded) return;
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    void saveSettings();
  }, 400);
}

/**
 * Persist settings from UI. Queued so only one PUT is in flight; trailing
 * snapshot runs after the previous finishes (avoids stale full-document race).
 * @returns {Promise<void>}
 */
async function saveSettings() {
  if (!settingsLoaded) return;
  // Chain saves so rapid edits apply the latest UI after prior PUT
  const run = async () => {
    const gen = ++settingsSaveGen;
    const next = readSettingsFromUi();
    try {
      const data = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      if (gen !== settingsSaveGen) return;
      if (data.settings) {
        settings = data.settings;
        if (settings.defaultCwd && !els.cwd?.value?.trim()) {
          setWorkspacePath(settings.defaultCwd);
        }
      }
    } catch (e) {
      if (gen !== settingsSaveGen) return;
      console.error("[greg] settings save failed", e);
      setStatus("error", "Settings save failed");
      applySettingsToUi(settings);
      // Re-apply last known good; leave hint briefly
      setTimeout(() => {
        const st = activeState();
        if (st?.sending) setStatus("busy", "Running…");
        else if (st?.alive) setStatus("ready", "Ready");
        else if (historyViewId) setStatus("idle", "History");
        else setStatus("idle", "Idle");
      }, 2500);
    }
  };

  settingsSaveChain = (settingsSaveChain || Promise.resolve())
    .then(run)
    .catch(() => {});
  await settingsSaveChain;
}

/** Flush pending debounced save before starting a session. */
async function flushSettingsSave() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    await saveSettings();
  } else if (settingsSaveChain) {
    await settingsSaveChain;
  }
}

/** @type {Array<{path:string,base:string,lastUsedAt:number}>} */
let recentsCache = [];

async function refreshRecents() {
  try {
    const data = await api("/api/recents");
    recentsCache = data.recents || [];
  } catch {
    recentsCache = [];
  }
  renderRecents();
}

/* ── Files panel (read-only workspace tree + preview) ───── */

/** @type {string|null} */
let filesRoot = null;
/** @type {string|null} */
let filesActivePath = null;
/** @type {number} */
let filesLoadGen = 0;
let filesPanelOpen = false;

function workspaceRootForFiles() {
  const st = activeState();
  if (st?.cwd) return st.cwd;
  const typed = (els.cwd?.value || "").trim();
  if (typed) return typed;
  return (settings.defaultCwd || "").trim() || null;
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Refresh Files panel when open and workspace root may have changed.
 * No-op when panel closed. Forces reload when root differs or force=true.
 * @param {{ force?: boolean }} [opts]
 */
function syncFilesPanelToWorkspace(opts = {}) {
  if (!filesPanelOpen) return;
  const next = workspaceRootForFiles();
  if (!opts.force && next && filesRoot && next === filesRoot) return;
  void refreshFilesTree();
}

function setFilesPanelOpen(open) {
  filesPanelOpen = Boolean(open);
  document.body.classList.toggle("files-open", filesPanelOpen);
  if (els.filesPanel) els.filesPanel.hidden = !filesPanelOpen;
  if (els.btnFiles) {
    els.btnFiles.setAttribute("aria-pressed", filesPanelOpen ? "true" : "false");
    els.btnFiles.classList.toggle("primary", filesPanelOpen);
    els.btnFiles.classList.toggle("subtle", !filesPanelOpen);
  }
  if (filesPanelOpen) {
    void refreshFilesTree();
  }
}

function toggleFilesPanel() {
  setFilesPanelOpen(!filesPanelOpen);
}

function clearFilesPreview(message = "Select a file", isError = false) {
  filesActivePath = null;
  if (els.filesPreviewPath) els.filesPreviewPath.textContent = message;
  if (els.filesPreviewMeta) els.filesPreviewMeta.textContent = "";
  if (els.filesPreview) {
    els.filesPreview.textContent = isError ? message : "";
    els.filesPreview.classList.toggle("is-empty", !isError);
    els.filesPreview.classList.toggle("is-error", isError);
  }
  if (els.filesTree) {
    for (const row of els.filesTree.querySelectorAll(".ft-row.is-active")) {
      row.classList.remove("is-active");
    }
  }
}

/**
 * @param {string} root
 * @param {string} [path]
 * @param {{ depth?: number }} [opts]
 */
async function fetchTree(root, path = "", opts = {}) {
  const q = new URLSearchParams({ root });
  if (path) q.set("path", path);
  if (opts.depth != null) q.set("depth", String(opts.depth));
  return api(`/api/fs/tree?${q}`);
}

/**
 * @param {Array<{name:string,type:string,path:string,size?:number,children?:unknown[]}>} entries
 * @param {HTMLElement} parentEl
 * @param {string} root
 */
function renderTreeEntries(entries, parentEl, root) {
  for (const entry of entries) {
    const node = document.createElement("div");
    node.className = "ft-node";
    node.dataset.path = entry.path;
    node.dataset.type = entry.type;

    const row = document.createElement("button");
    row.type = "button";
    row.className = "ft-row";
    row.setAttribute("role", "treeitem");
    row.title = entry.path;

    const twist = document.createElement("span");
    twist.className = "ft-twist";
    twist.setAttribute("aria-hidden", "true");

    const icon = document.createElement("span");
    icon.className = "ft-icon";
    icon.setAttribute("aria-hidden", "true");

    const name = document.createElement("span");
    name.className = "ft-name";
    name.textContent = entry.name;

    if (entry.type === "dir") {
      // depth:0 load — children never prefetched; expand always fetches
      twist.textContent = "▸";
      icon.textContent = "📁";
      row.setAttribute("aria-expanded", "false");

      const kids = document.createElement("div");
      kids.className = "ft-children is-collapsed";
      kids.setAttribute("role", "group");
      kids.dataset.loaded = "0";
      kids.dataset.loading = "0";
      /** @type {number} */
      let expandGen = 0;

      row.addEventListener("click", async () => {
        const collapsed = kids.classList.contains("is-collapsed");
        if (!collapsed) {
          kids.classList.add("is-collapsed");
          twist.textContent = "▸";
          row.setAttribute("aria-expanded", "false");
          return;
        }

        // Expand
        if (kids.dataset.loading === "1") return;

        if (kids.dataset.loaded !== "1") {
          kids.dataset.loading = "1";
          twist.textContent = "…";
          const gen = ++expandGen;
          try {
            // depth 0: list this directory only (lazy)
            const data = await fetchTree(root, entry.path, { depth: 0 });
            if (gen !== expandGen) return;
            kids.innerHTML = "";
            renderTreeEntries(data.entries || [], kids, root);
            kids.dataset.loaded = "1";
            if (data.truncated) {
              const note = document.createElement("div");
              note.className = "files-tree-empty";
              note.textContent = "Listing truncated…";
              kids.appendChild(note);
            }
          } catch (e) {
            if (gen !== expandGen) return;
            kids.innerHTML = "";
            const err = document.createElement("div");
            err.className = "files-tree-error";
            err.textContent = e.message || "Failed to load";
            kids.appendChild(err);
            // Allow retry on next expand (do not lock loaded=1)
            kids.dataset.loaded = "0";
          } finally {
            if (gen === expandGen) kids.dataset.loading = "0";
          }
        }

        kids.classList.remove("is-collapsed");
        twist.textContent = "▾";
        row.setAttribute("aria-expanded", "true");
      });

      node.appendChild(row);
      row.appendChild(twist);
      row.appendChild(icon);
      row.appendChild(name);
      node.appendChild(kids);
    } else {
      twist.textContent = "";
      icon.textContent = entry.type === "file" ? "📄" : "•";
      row.addEventListener("click", () => {
        void openFilePreview(root, entry.path, row);
      });
      node.appendChild(row);
      row.appendChild(twist);
      row.appendChild(icon);
      row.appendChild(name);
    }

    parentEl.appendChild(node);
  }
}

async function refreshFilesTree() {
  if (!els.filesTree) return;
  const root = workspaceRootForFiles();
  const gen = ++filesLoadGen;

  if (!root) {
    filesRoot = null;
    if (els.filesRootLabel) {
      els.filesRootLabel.textContent = "Set a workspace path";
      els.filesRootLabel.title = "";
    }
    els.filesTree.innerHTML =
      '<div class="files-tree-empty">Enter a workspace path (or start a session) to browse files.</div>';
    clearFilesPreview("No workspace");
    return;
  }

  if (els.filesRootLabel) {
    els.filesRootLabel.textContent = root;
    els.filesRootLabel.title = root;
  }
  els.filesTree.innerHTML =
    '<div class="files-tree-empty">Loading…</div>';
  clearFilesPreview("Select a file");

  try {
    // depth 0: only this directory — expand loads children (avoids huge DOM)
    const data = await fetchTree(root, "", { depth: 0 });
    if (gen !== filesLoadGen) return;
    filesRoot = data.root || root;
    if (els.filesRootLabel) {
      els.filesRootLabel.textContent = filesRoot;
      els.filesRootLabel.title = filesRoot;
    }
    els.filesTree.innerHTML = "";
    const entries = data.entries || [];
    if (!entries.length) {
      els.filesTree.innerHTML =
        '<div class="files-tree-empty">Empty directory (or only ignored folders).</div>';
      return;
    }
    renderTreeEntries(entries, els.filesTree, filesRoot);
    if (data.truncated) {
      const note = document.createElement("div");
      note.className = "files-tree-empty";
      note.textContent = "Listing truncated (too many entries).";
      els.filesTree.appendChild(note);
    }
  } catch (e) {
    if (gen !== filesLoadGen) return;
    filesRoot = null;
    els.filesTree.innerHTML = `<div class="files-tree-error">${escapeHtml(
      e.message || "Failed to load tree",
    )}</div>`;
    clearFilesPreview(e.message || "Failed to load tree", true);
  }
}

/**
 * @param {string} root
 * @param {string} path
 * @param {HTMLElement} [rowEl]
 */
async function openFilePreview(root, path, rowEl) {
  if (!els.filesPreview) return;
  filesActivePath = path;
  if (els.filesTree) {
    for (const row of els.filesTree.querySelectorAll(".ft-row.is-active")) {
      row.classList.remove("is-active");
    }
  }
  if (rowEl) rowEl.classList.add("is-active");

  if (els.filesPreviewPath) els.filesPreviewPath.textContent = path;
  if (els.filesPreviewMeta) els.filesPreviewMeta.textContent = "…";
  els.filesPreview.textContent = "Loading…";
  els.filesPreview.classList.remove("is-empty", "is-error");

  try {
    const q = new URLSearchParams({ root, path });
    const data = await api(`/api/fs/file?${q}`);
    if (filesActivePath !== path) return;
    els.filesPreview.textContent = data.content ?? "";
    els.filesPreview.classList.remove("is-empty", "is-error");
    if (els.filesPreviewPath) {
      els.filesPreviewPath.textContent = data.path || path;
    }
    if (els.filesPreviewMeta) {
      const parts = [formatBytes(data.size)];
      if (data.truncated) parts.push("truncated");
      els.filesPreviewMeta.textContent = parts.join(" · ");
    }
  } catch (e) {
    if (filesActivePath !== path) return;
    const msg = e.message || "Failed to open file";
    els.filesPreview.textContent = msg;
    els.filesPreview.classList.add("is-error");
    els.filesPreview.classList.remove("is-empty");
    if (els.filesPreviewMeta) els.filesPreviewMeta.textContent = "";
  }
}

function renderRecents() {
  if (!els.recentsList) return;
  els.recentsList.innerHTML = "";
  // Compact chips — name only, max 5, skip current cwd
  const current = (els.cwd?.value || "").trim();
  const items = recentsCache
    .filter((r) => r.path !== current)
    .slice(0, 5);
  for (const item of items) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "recent-chip";
    const name = item.base || cwdBase(item.path) || item.path;
    pick.textContent = name;
    pick.title = item.path;
    pick.addEventListener("click", () => {
      if (creatingSession) return;
      setWorkspacePath(item.path, { openFiles: true });
      void newSession();
    });
    els.recentsList.appendChild(pick);
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

/**
 * Best-effort live bubble count for Earlier chips before /api/history returns.
 * @param {TabState} st
 * @returns {number|undefined}
 */
function estimateLiveMessageCount(st) {
  if (!st) return undefined;
  if (st.tabId === activeTabId && els.transcript && !historyViewId) {
    let n = 0;
    for (const child of els.transcript.children) {
      if (child === els.emptyState) continue;
      if (child.classList?.contains("empty-state")) continue;
      n += 1;
    }
    if (n > 0) return n;
  }
  if (st.park && st.park.childNodes && st.park.childNodes.length > 0) {
    return st.park.childNodes.length;
  }
  return undefined;
}

/**
 * Push a live tab into historyCache so it appears under Earlier immediately
 * when demoted (before the next /api/history round-trip).
 * @param {TabState} st
 */
function seedHistoryCacheFromTab(st) {
  if (!st?.tabId) return;
  const id = st.tabId;
  const idx = historyCache.findIndex((h) => h.id === id);
  const prev = idx >= 0 ? historyCache[idx] : null;
  const estimated = estimateLiveMessageCount(st);
  const messageCount =
    typeof prev?.messageCount === "number" && prev.messageCount > 0
      ? prev.messageCount
      : estimated;
  const row = {
    id,
    title: st.title ?? prev?.title ?? null,
    cwd: st.cwd || prev?.cwd || "",
    cwdBase: cwdBase(st.cwd) || prev?.cwdBase || "",
    updatedAt: Date.now(),
    ...(typeof messageCount === "number" ? { messageCount } : {}),
    ...(prev?.source ? { source: prev.source } : {}),
  };
  if (idx >= 0) historyCache.splice(idx, 1);
  historyCache.unshift(row);
}

/**
 * Fire-and-forget server stop (orphaned resume, optimistic demote).
 * @param {string|null|undefined} tabId
 */
function stopServerTabBackground(tabId) {
  if (!tabId) return;
  void api("/api/session/stop", {
    method: "POST",
    body: JSON.stringify({ tabId }),
  }).catch(() => {});
}

/**
 * Demote all live tabs to Earlier in the sidebar (optimistic), stop agents.
 * @param {string|null} [keepId]
 * @returns {string[]} stopped tab ids
 */
function demoteLiveTabsOptimistic(keepId = null) {
  /** @type {string[]} */
  const stopped = [];
  for (const id of [...tabStates.keys()]) {
    if (keepId && id === keepId) continue;
    const st = tabStates.get(id);
    if (!st) continue;
    // Finish streaming markdown so demoted UI/history seed is not mid-chunk
    finalizeMarkdownBubble(st.liveAgentBubble);
    discardEmptyAgentBubble(st.liveAgentBubble);
    seedHistoryCacheFromTab(st);
    closeStream(st);
    tabStates.delete(id);
    stopped.push(id);
    // Server stop in background — UI already moved
    stopServerTabBackground(id);
  }
  return stopped;
}

function clearPendingResume() {
  pendingResumeId = null;
  pendingResumeMeta = null;
}

function renderSessionList() {
  if (!els.sessionList) return;
  const items = [...tabStates.values()].sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );
  els.sessionList.innerHTML = "";

  for (const st of items) {
    const row = document.createElement("div");
    row.className = "chat-item session-item";
    if (st.tabId === activeTabId && !historyViewId) row.classList.add("active");
    if (!st.alive) row.classList.add("dead");
    if (st.sending) row.classList.add("busy");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "chat-pick session-pick";
    pick.title = st.cwd || st.tabId;

    const dot = document.createElement("span");
    dot.className = "chat-dot";
    if (st.sending) dot.classList.add("busy");
    else if (st.alive) dot.classList.add("live");
    else dot.classList.add("dead");
    dot.setAttribute("aria-hidden", "true");

    const body = document.createElement("span");
    body.className = "chat-body";
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent = displayTitle(st);
    body.appendChild(title);
    const proj = cwdBase(st.cwd);
    if (proj) {
      const sub = document.createElement("span");
      sub.className = "chat-sub";
      sub.textContent = proj;
      body.appendChild(sub);
    }

    pick.appendChild(dot);
    pick.appendChild(body);
    pick.addEventListener("click", () => {
      switchToTab(st.tabId);
      closeSidebar();
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn icon chat-action session-close";
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

  // Optimistic Active row while Earlier chat is resuming (not yet in tabStates)
  if (pendingResumeId && !tabStates.has(pendingResumeId)) {
    const meta = pendingResumeMeta || {};
    const row = document.createElement("div");
    row.className = "chat-item session-item active busy";
    row.dataset.pendingResume = pendingResumeId;

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "chat-pick session-pick";
    pick.title = meta.cwd || pendingResumeId;
    pick.disabled = true;

    const dot = document.createElement("span");
    dot.className = "chat-dot busy";
    dot.setAttribute("aria-hidden", "true");

    const body = document.createElement("span");
    body.className = "chat-body";
    const title = document.createElement("span");
    title.className = "chat-title";
    title.textContent =
      meta.title || meta.cwdBase || `Chat ${shortId(pendingResumeId)}`;
    body.appendChild(title);
    if (meta.cwdBase) {
      const sub = document.createElement("span");
      sub.className = "chat-sub";
      sub.textContent = meta.cwdBase;
      body.appendChild(sub);
    }

    pick.appendChild(dot);
    pick.appendChild(body);
    row.appendChild(pick);
    els.sessionList.appendChild(row);
  }

  syncChatDivider();
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

/**
 * Stable key for tool cards. Prefer ACP ids; otherwise reuse the last open
 * anonymous card of the same title so updates merge instead of stacking.
 * @param {TabState} st
 * @param {Record<string, unknown>} update
 */
function toolCardKey(st, update) {
  const id = String(
    update.toolCallId || update.tool_call_id || update.id || "",
  ).trim();
  if (id) return id;

  const title = String(update.title || update.toolName || update.kind || "tool");
  // Prefer last incomplete anon card with same title
  for (const [key, card] of st.toolCards) {
    if (!String(key).startsWith("__anon:")) continue;
    const prev = st.toolState.get(key) || {};
    const prevTitle = String(prev.title || prev.toolName || prev.kind || "tool");
    if (prevTitle !== title) continue;
    const status = String(prev.status || "").toLowerCase();
    if (!status || status === "pending" || status === "in_progress" || status === "running") {
      return key;
    }
  }
  return `__anon:${title}:${st.toolCards.size}`;
}

function handleAcp(tabId, msg) {
  const st = tabStates.get(tabId);
  if (!st) return;

  if (msg.method !== "session/update" && msg.method !== "x.ai/session/update") {
    return;
  }
  const params = msg.params || {};
  const update = params.update || params.sessionUpdate || params;
  // Align with cards.sessionUpdateKind — never treat tool category as update type
  const kind = update.sessionUpdate || update.type || "";

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
    // Finalize live text bubbles so later chunks appear *after* the card
    resetLive(st);
    const key = toolCardKey(st, update);
    const prev = st.toolState.get(key) || {};
    const merged = mergeToolUpdate(prev, update);
    st.toolState.set(key, merged);

    const existing = st.toolCards.get(key) || null;
    const card = upsertToolCard(existing, merged);
    st.toolCards.set(key, card);
    mountTabCard(st, card, !existing);
    return;
  }
  if (kind === "plan") {
    resetLive(st);
    const existing = st.planCard;
    const card = upsertPlanCard(existing, update);
    st.planCard = card;
    mountTabCard(st, card, !existing);
    return;
  }
  // Grok Build diff review — upsert by stable id when present
  if (kind === "diff_review") {
    resetLive(st);
    const toolCallId = String(
      update.toolCallId || update.tool_call_id || update.id || "diff_review",
    );
    const key = toolCallId.startsWith("__") ? toolCallId : `diff_review:${toolCallId}`;
    const prev = st.toolState.get(key) || {};
    const synthetic = mergeToolUpdate(prev, {
      ...update,
      title: update.title || prev.title || "Diff review",
      kind: "diff_review",
      status: update.status || prev.status || "completed",
      toolCallId: key,
    });
    st.toolState.set(key, synthetic);
    const existing = st.toolCards.get(key) || null;
    const card = upsertToolCard(existing, synthetic);
    st.toolCards.set(key, card);
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
    // No pending full card — those boxes left green double-bars after resolve.
    // Only a compact one-line note once the API returns.
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
      const card = renderPermissionCard(st, {
        summary,
        options: [],
        auto: true,
      });
      resolvePermissionCard(card, {
        label: allow.name,
        state: "auto-done",
      });
    } catch (e) {
      const card = renderPermissionCard(st, {
        summary,
        options: [],
        auto: true,
      });
      resolvePermissionCard(card, {
        label: e.message,
        state: "failed",
      });
    }
    return;
  }

  const card = renderPermissionCard(st, {
    summary,
    options,
    auto: false,
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
 * @param {{ summary: ReturnType<typeof summarizePermission>, options: ReturnType<typeof extractPermissionOptions>, auto: boolean }} opts
 */
function renderPermissionCard(st, { summary, options: _options, auto }) {
  const card = document.createElement("div");
  // Not `.bubble` — base bubble border + perm-card border stacked into thick bars
  card.className = `perm-card${auto ? " auto" : ""}`;
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

  // Flatten to a one-line note (CSS hides head/body/actions) — full boxes
  // with green borders were the "two horizontal bars" after approve.
  const headline =
    card.querySelector(".perm-title")?.textContent?.trim() || "";
  const actions = card.querySelector(".perm-actions");
  if (actions) {
    for (const btn of actions.querySelectorAll("button")) {
      btn.disabled = true;
    }
  }

  const text = card.querySelector(".outcome-text");
  if (text) {
    const prefix =
      state === "auto-done"
        ? "Auto-approved"
        : state === "allowed"
          ? "Allowed"
          : state === "denied"
            ? "Denied"
            : state === "failed"
              ? "Failed"
              : "Done";
    // Prefer short outcome; keep tool name when useful
    const detail = label && label !== prefix ? label : headline;
    text.textContent = detail ? `${prefix} · ${detail}` : prefix;
  }

  const badge = card.querySelector(".perm-badge");
  if (badge && state === "auto-done") badge.textContent = "Auto-approved";
  else if (badge && state === "allowed") badge.textContent = "Allowed";
  else if (badge && state === "denied") badge.textContent = "Denied";
  else if (badge && state === "failed") badge.textContent = "Failed";

  card.setAttribute(
    "aria-label",
    text?.textContent || "Permission resolved",
  );
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
    els.hint.textContent = "New task to start";
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
    els.hint.textContent = "Session stopped — new task or pick a chat";
  } else if (busy) {
    els.hint.textContent = "Running… Cancel / Ctrl+.";
  } else {
    els.hint.textContent = "Enter to send · Ctrl+. cancel";
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
      ? "Session stopped — new task or pick a chat"
      : "New task to start";
    return;
  }
  refreshActiveComposer();
}

/**
 * Empty-state suggestion chips (Codex-style).
 * @param {string} action
 */
async function handleEmptyCard(action) {
  const prompts = {
    explore:
      "Explore this codebase: outline structure, key modules, and how to run it.",
    feature:
      "Help me design and implement a new feature. Ask clarifying questions first.",
    review:
      "Review recent changes and suggest improvements, risks, and missing tests.",
    fix: "Find and fix bugs or failing behavior in this project. Start with a quick diagnosis.",
  };

  if (action === "explore") {
    const root = (els.cwd?.value || "").trim();
    if (!root) {
      openFolderPicker();
      return;
    }
    setFilesPanelOpen(true);
    void refreshFilesTree();
  }

  const text = prompts[action];
  if (!text) return;

  // Ensure a live session, then fill + send
  let st = activeState();
  if (!st?.alive) {
    await newSession();
    st = activeState();
  }
  if (!st?.alive) return;
  els.prompt.value = text;
  st.draft = text;
  void sendPrompt();
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
 * Switch UI to another live tab.
 * @param {string} tabId
 */
function switchToTab(tabId) {
  if (tabId === activeTabId && !historyViewId) return;
  const next = tabStates.get(tabId);
  if (!next) return;

  // Leaving history replay
  historyViewId = null;

  // Hide first (keep nodes so we can park), then swap, then show once
  beginTranscriptSwap({ clear: false });
  const prev = activeState();
  if (prev && activeTabId) {
    prev.draft = els.prompt.value;
    parkActiveTranscript(prev);
  } else {
    clearTranscriptMessages();
  }

  activeTabId = tabId;
  restoreTranscript(next);
  endTranscriptSwap();

  els.prompt.value = next.draft || "";
  if (next.cwd) setWorkspacePath(next.cwd);

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
  renderHistoryList();
  syncFilesPanelToWorkspace();
  if (next.alive) els.prompt.focus();
}

/**
 * Open a saved chat and auto-resume the agent in the same workspace.
 * Reuses the transcript id so new messages append to the same history file.
 * Falls back to read-only view only if the agent fails to start.
 * @param {string} id
 */
async function openHistory(id) {
  const gen = ++historyLoadGen;

  // Already live under this id → just switch (and drop any stray other tabs)
  const live = tabStates.get(id);
  if (live?.alive) {
    clearPendingResume();
    historyViewId = null;
    demoteLiveTabsOptimistic(id);
    renderSessionList();
    renderHistoryList();
    switchToTab(id);
    closeSidebar();
    void refreshHistory();
    return;
  }

  // ── Optimistic sidebar (sync, before any await) ──────────────
  // From: Active=A, Earlier=B  →  immediately Active=B(resuming), Earlier=A
  // Without this, stop/fetch leaves A in Active while A+B both show in Earlier.
  const histItem = historyCache.find((h) => h.id === id) || null;
  pendingResumeId = id;
  pendingResumeMeta = {
    title: histItem?.title ?? null,
    cwd: histItem?.cwd || "",
    cwdBase: histItem?.cwdBase || cwdBase(histItem?.cwd) || "",
  };
  demoteLiveTabsOptimistic(null);
  activeTabId = null;
  historyViewId = null;
  beginTranscriptSwap({ clear: true });
  closeSidebar();
  setStatus("busy", "Resuming…");
  setComposerEnabled(false);
  setStopEnabled(false);
  els.prompt.value = "";
  updateSessionLabel(null);
  if (els.sessionLabel && pendingResumeMeta) {
    const t =
      pendingResumeMeta.title ||
      pendingResumeMeta.cwdBase ||
      `chat · ${shortId(id)}`;
    els.sessionLabel.textContent = `${t} · resuming…`;
  }
  renderSessionList();
  renderHistoryList();

  /** @type {object|null} */
  let doc = null;
  try {
    doc = await api(`/api/history/${encodeURIComponent(id)}`);
  } catch (e) {
    // Stale gen must not end swap — newer openHistory owns reveal
    if (gen !== historyLoadGen) return;
    clearPendingResume();
    setStatus("error", "Failed");
    clearTranscriptMessages();
    const div = document.createElement("div");
    div.className = "bubble system";
    div.textContent = `Failed to load chat: ${e.message}`;
    els.transcript.appendChild(div);
    markTranscriptFilled();
    endTranscriptSwap();
    renderSessionList();
    renderHistoryList();
    return;
  }
  if (gen !== historyLoadGen) return;

  // Refresh pending label from loaded doc
  pendingResumeMeta = {
    title: doc.title ?? pendingResumeMeta?.title ?? null,
    cwd: doc.cwd || pendingResumeMeta?.cwd || "",
    cwdBase: cwdBase(doc.cwd) || pendingResumeMeta?.cwdBase || "",
  };
  renderSessionList();

  if (doc.cwd) setWorkspacePath(doc.cwd);
  syncFilesPanelToWorkspace({ force: true });

  // One atomic paint, then reveal
  paintHistoryMessages(doc.messages || []);
  endTranscriptSwap();

  await flushSettingsSave();
  if (gen !== historyLoadGen) return;

  // Concurrent New task / other resume owns session creation — stay view-only
  if (creatingSession) {
    clearPendingResume();
    historyViewId = id;
    activeTabId = null;
    setStatus("idle", "View only");
    setComposerEnabled(false);
    setStopEnabled(false);
    if (els.sessionLabel) {
      els.sessionLabel.textContent = doc.title
        ? `${doc.title} · offline`
        : `chat · ${shortId(id)}`;
    }
    renderSessionList();
    renderHistoryList();
    return;
  }
  creatingSession = true;
  if (els.btnNew) els.btnNew.disabled = true;

  try {
    const data = await api("/api/session/new", {
      method: "POST",
      body: JSON.stringify({
        tabId: id,
        cwd: doc.cwd || els.cwd?.value || undefined,
        title: doc.title || null,
        resume: true,
        alwaysApprove: els.alwaysApprove?.checked === true,
        ...sessionModelEffortFromUi(),
      }),
    });
    if (gen !== historyLoadGen) {
      // Abandoned resume left a live agent the client will never adopt
      stopServerTabBackground(data?.tabId);
      return;
    }

    // Drop any stray live tabs; keep the resumed id
    demoteLiveTabsOptimistic(data.tabId);

    const st = ensureTabState({
      tabId: data.tabId,
      sessionId: data.sessionId,
      cwd: data.cwd || doc.cwd || "",
      title: data.title || doc.title || null,
      alive: true,
      createdAt: data.createdAt || doc.createdAt,
      lastActiveAt: data.lastActiveAt || Date.now(),
    });
    st.draft = "";
    st.park = null;
    resetLive(st);

    // Live tab now owns Active — clear optimistic placeholder
    clearPendingResume();
    activeTabId = st.tabId;
    historyViewId = null;

    const seed = data.contextSeed;
    const seedNote = data.contextSeeded
      ? seed?.truncated
        ? ` · model context restored (${seed.messageCount} turns, truncated)`
        : ` · model context restored (${seed?.messageCount ?? "?"} turns)`
      : doc.messages?.length
        ? ` · ${doc.messages.length} earlier messages (UI only — no model seed)`
        : "";
    appendBubble(
      st,
      "system",
      `Resumed · ${data.cwd || doc.cwd || "—"}${seedNote}`,
    );

    if (data.cwd) setWorkspacePath(data.cwd, { openFiles: false });
    connectStream(st);
    updateSessionLabel(st);
    setStatus("ready", "Ready");
    setComposerEnabled(true);
    setStopEnabled(true);
    renderSessionList();
    renderHistoryList();
    void refreshHistory();
    void refreshRecents();
    syncFilesPanelToWorkspace();
    els.prompt.focus();
  } catch (e) {
    if (gen !== historyLoadGen) return;
    // Fallback: view transcript only if agent cannot start
    clearPendingResume();
    historyViewId = id;
    activeTabId = null;
    setStatus("error", "View only");
    setComposerEnabled(false);
    setStopEnabled(false);
    els.sessionLabel.textContent = doc.title
      ? `${doc.title} · offline`
      : `chat · ${shortId(id)}`;
    els.hint.textContent =
      "Could not resume agent — transcript only. Fix grok / try New task.";
    // History is already painted — only add the error note
    const div = document.createElement("div");
    div.className = "bubble system";
    div.textContent = `Resume failed: ${e.message}${
      e.data?.hint ? ` — ${e.data.hint}` : ""
    }. Showing saved transcript only.`;
    els.transcript.appendChild(div);
    markTranscriptFilled();
    scrollTranscript({ force: true });
    renderSessionList();
    renderHistoryList();
  } finally {
    creatingSession = false;
    if (els.btnNew) els.btnNew.disabled = false;
  }
}

/**
 * Rebuild a live-style tool card from a durable history row.
 * @param {{ text?: string, meta?: Record<string, unknown> }} m
 * @returns {HTMLElement}
 */
function historyToolCard(m) {
  const meta =
    m.meta && typeof m.meta === "object"
      ? /** @type {Record<string, unknown>} */ (m.meta)
      : {};
  const text = String(m.text || "");
  // Legacy rows only stored "title · status" in text
  let title = meta.title ? String(meta.title) : "";
  let status = meta.status ? String(meta.status) : "";
  if (!title || !status) {
    const parts = text.split(" · ");
    if (!title && parts[0]) title = parts[0];
    if (!status && parts.length > 1) status = parts.slice(1).join(" · ");
  }
  const update = {
    sessionUpdate: "tool_call",
    toolCallId: meta.toolCallId || meta.tool_call_id || undefined,
    title: title || "tool",
    status: status || "completed",
    kind: meta.kind || undefined,
    locations: meta.locations,
    rawInput: meta.rawInput ?? meta.raw_input,
    rawOutput: meta.rawOutput ?? meta.raw_output,
    content: meta.content,
  };
  return upsertToolCard(null, update);
}

/**
 * @param {{ role: string, text: string, ts?: number, meta?: object }} m
 * @param {HTMLElement|DocumentFragment} [host] defaults to live transcript
 */
function renderHistoryMessage(m, host = els.transcript) {
  const role = m.role || "system";
  const text = m.text || "";
  const meta =
    m.meta && typeof m.meta === "object"
      ? /** @type {Record<string, unknown>} */ (m.meta)
      : {};
  const append = (div) => {
    host.appendChild(div);
  };
  if (role === "user") {
    const div = document.createElement("div");
    div.className = "bubble user";
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = "you";
    div.appendChild(r);
    const body = document.createElement("div");
    body.className = "md-body";
    div.appendChild(body);
    div._rawText = text;
    setMarkdownBody(body, text, { streaming: false });
    append(div);
    return;
  }
  if (role === "agent") {
    // Skip decorative-only rows so history does not reintroduce hollow bars
    if (isDecorativeOnlyMarkdown(text)) return;
    const div = document.createElement("div");
    div.className = "bubble agent";
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = "greg";
    div.appendChild(r);
    const body = document.createElement("div");
    body.className = "md-body";
    div.appendChild(body);
    div._rawText = text;
    setMarkdownBody(body, text, { streaming: false });
    append(div);
    return;
  }
  if (role === "thought") {
    append(createThoughtBubble(text, { open: false }));
    return;
  }
  if (role === "tool") {
    append(historyToolCard(m));
    return;
  }
  if (role === "plan") {
    const entries = Array.isArray(meta.entries)
      ? meta.entries
      : Array.isArray(meta.plan)
        ? meta.plan
        : null;
    if (entries) {
      append(upsertPlanCard(null, { entries }));
    } else {
      // Legacy plan rows: plain bullet text
      append(
        upsertPlanCard(null, {
          entries: text
            .split("\n")
            .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
            .filter(Boolean)
            .map((content) => ({ content, status: "completed" })),
        }),
      );
    }
    return;
  }
  if (role === "permission") {
    // Live permission cards only — never replay "Agent request: …" history noise
    return;
  }
  const div = document.createElement("div");
  div.className = "bubble system";
  div.appendChild(document.createTextNode(text));
  append(div);
}

/**
 * Load durable transcript into a live tab's park/host (best-effort cards as text).
 * @param {TabState} st
 */
async function loadTabTranscript(st) {
  if (!st?.tabId) return;
  try {
    const doc = await api(`/api/history/${encodeURIComponent(st.tabId)}`);
    const messages = doc.messages || [];
    if (!messages.length) return;
    const toLive = st.tabId === activeTabId && !historyViewId;
    if (toLive) {
      paintHistoryMessages(messages);
      return;
    }
    // Parked tab: only seed park when empty (never append onto live SSE nodes)
    if (st.park && st.park.childNodes.length > 0) return;
    const frag = document.createDocumentFragment();
    for (const m of messages) {
      renderHistoryMessage(m, frag);
    }
    st.park = frag;
  } catch {
    /* history optional for live tabs */
  }
}

async function loadHistoryList() {
  try {
    const data = await api("/api/history");
    return data.sessions || [];
  } catch {
    return [];
  }
}

/** @type {Array<{id:string,title:string|null,cwd:string,cwdBase:string,updatedAt:number,messageCount:number}>} */
let historyCache = [];

async function refreshHistory() {
  historyCache = await loadHistoryList();
  renderHistoryList();
}

/** Debounced refresh — avoid full list reload after every prompt. */
function scheduleHistoryRefresh(ms = 800) {
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    void refreshHistory();
  }, ms);
}

function syncChatDivider() {
  const div = $("history-divider");
  if (!div) return;
  const hasLive = els.sessionList && els.sessionList.children.length > 0;
  const hasHist = els.historyList && els.historyList.children.length > 0;
  div.hidden = !(hasLive && hasHist);
}

function renderHistoryList() {
  if (!els.historyList) return;
  els.historyList.innerHTML = "";

  // Live tabs + in-flight resume appear under Active — skip them in Earlier
  const liveIds = new Set(tabStates.keys());
  if (pendingResumeId) liveIds.add(pendingResumeId);

  for (const item of historyCache) {
    if (liveIds.has(item.id)) continue;

    const row = document.createElement("div");
    row.className = "chat-item history-item";
    if (historyViewId === item.id) row.classList.add("active");

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "chat-pick history-pick";
    const title = item.title || item.cwdBase || "Chat";
    pick.title = item.cwd || item.id;

    const dot = document.createElement("span");
    dot.className = "chat-dot past";
    dot.setAttribute("aria-hidden", "true");

    const body = document.createElement("span");
    body.className = "chat-body";
    const titleEl = document.createElement("span");
    titleEl.className = "chat-title";
    titleEl.textContent = title;
    if (item.source === "grok") {
      const tag = document.createElement("span");
      tag.className = "chat-source-tag";
      tag.textContent = "· grok";
      tag.title = "Imported from Grok Build";
      titleEl.appendChild(tag);
    }
    body.appendChild(titleEl);
    if (item.cwdBase) {
      const sub = document.createElement("span");
      sub.className = "chat-sub";
      sub.textContent = item.cwdBase;
      body.appendChild(sub);
    }

    pick.appendChild(dot);
    pick.appendChild(body);
    pick.addEventListener("click", () => openHistory(item.id));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn icon chat-action history-delete";
    del.title = "Delete";
    del.setAttribute("aria-label", "Delete from history");
    del.textContent = "×";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const label = item.title || item.cwdBase || "chat";
      if (!confirm(`Delete “${label}”? This cannot be undone.`)) {
        return;
      }
      try {
        await api(`/api/history/${encodeURIComponent(item.id)}`, {
          method: "DELETE",
        });
        if (historyViewId === item.id) {
          historyViewId = null;
          for (const child of [...els.transcript.children]) {
            if (child !== els.emptyState) child.remove();
          }
          els.transcript.classList.remove("has-messages");
          updateSessionLabel(null);
          setStatus("idle", "Idle");
          setComposerEnabled(false);
        }
        await refreshHistory();
      } catch (err) {
        alert(err.message || "Delete failed");
      }
    });

    row.appendChild(pick);
    row.appendChild(del);
    els.historyList.appendChild(row);
  }

  syncChatDivider();
}

/**
 * Stop a live tab without switching UI to another session.
 * @param {string} tabId
 * @returns {Promise<boolean>}
 */
async function stopSessionCore(tabId) {
  const st = tabStates.get(tabId);
  if (!st) return false;
  try {
    await api("/api/session/stop", {
      method: "POST",
      body: JSON.stringify({ tabId }),
    });
  } catch {
    // Still drop local state if server already gone
  }
  closeStream(st);
  tabStates.delete(tabId);
  return true;
}

/**
 * Product rule: only one live agent. Stop every tab except optional keepId.
 * @param {string|null} [keepId]
 */
async function stopAllLiveSessions(keepId = null) {
  const ids = [...tabStates.keys()].filter((id) => id !== keepId);
  for (const id of ids) {
    const st = tabStates.get(id);
    if (st) seedHistoryCacheFromTab(st);
    await stopSessionCore(id);
  }
  if (ids.length) {
    renderSessionList();
    renderHistoryList();
    void refreshHistory();
  }
}

async function newSession() {
  if (creatingSession) return;
  creatingSession = true;
  if (els.btnNew) els.btnNew.disabled = true;
  // Abort any in-flight openHistory so it cannot fight New task for swap/UI
  historyLoadGen += 1;
  clearPendingResume();
  endTranscriptSwap();
  setStatus("busy", "Starting agent…");
  setComposerEnabled(false);
  setStopEnabled(false);
  closeSidebar();
  // Ensure disk settings match UI (model clear must win over stale settings.model)
  await flushSettingsSave();

  // Single-session product: end any live agent before starting a new one
  await stopAllLiveSessions(null);

  // Clear view while spawning
  for (const child of [...els.transcript.children]) {
    if (child !== els.emptyState) child.remove();
  }
  els.transcript.classList.remove("has-messages");
  historyViewId = null;
  activeTabId = null;
  els.prompt.value = "";

  try {
    const data = await api("/api/session/new", {
      method: "POST",
      body: JSON.stringify({
        cwd: els.cwd.value.trim() || undefined,
        // Always send explicit values so session matches the form (WYSIWYG)
        alwaysApprove: els.alwaysApprove?.checked === true,
        ...sessionModelEffortFromUi(),
      }),
    });

    // Drop any stale local tabs (server also enforces single live session)
    await stopAllLiveSessions(data.tabId);
    for (const id of [...tabStates.keys()]) {
      if (id !== data.tabId) tabStates.delete(id);
    }

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

    if (data.cwd) setWorkspacePath(data.cwd, { openFiles: true });
    connectStream(st);
    updateSessionLabel(st);
    setStatus("ready", "Ready");
    setComposerEnabled(true);
    setStopEnabled(true);
    renderSessionList();
    void refreshHistory(); // immediate on new session
    void refreshRecents();
    syncFilesPanelToWorkspace();
    els.prompt.focus();
  } catch (e) {
    setStatus("error", "Failed");
    const hint = e.data?.hint ? `\n${e.data.hint}` : "";
    const code = e.data?.code ? ` (${e.data.code})` : "";
    const msg = `${e.message}${code}${hint}`;

    const div = document.createElement("div");
    div.className = "bubble system";
    div.textContent = msg;
    els.transcript.appendChild(div);
    markTranscriptFilled();
    setComposerEnabled(false);
    setStopEnabled(false);
    updateSessionLabel(null);
    renderSessionList();
  } finally {
    creatingSession = false;
    if (els.btnNew) els.btnNew.disabled = false;
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

  const ok = await stopSessionCore(tabId);
  if (!ok && tabStates.has(tabId)) {
    if (tabId === activeTabId) {
      appendBubble(st, "system", "Stop failed");
      setStopEnabled(true);
    }
    return;
  }
  void refreshHistory();

  if (activeTabId === tabId) {
    activeTabId = null;
    // Single-session product: no multi-tab switch after stop
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
  // New user turn: re-pin to bottom so streaming follows unless they scroll away
  scrollTranscript({ force: true });
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
    // Final markdown pass (complete fences, no "streaming…" badge)
    finalizeMarkdownBubble(st.liveAgentBubble);
    discardEmptyAgentBubble(st.liveAgentBubble);
    st.liveAgentBubble = null;
    if (cancelled) {
      // Always record on this tab's transcript (may be parked)
      appendBubble(st, "system", "Turn cancelled");
    }
    if (st.tabId === activeTabId) {
      if (cancelled) setStatus("ready", "Cancelled");
      else if (st.alive) setStatus("ready", "Ready");
    }
  } catch (e) {
    finalizeMarkdownBubble(st.liveAgentBubble);
    discardEmptyAgentBubble(st.liveAgentBubble);
    st.liveAgentBubble = null;
    appendBubble(st, "system", e.message);
    if (st.tabId === activeTabId) setStatus("error", "Error");
  } finally {
    st.sending = false;
    st.cancelHttpInflight = false;
    renderSessionList();
    scheduleHistoryRefresh();
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
    // Prefer most recently active live tab only (single-session product)
    const list = (data.tabs || [])
      .filter((t) => t.alive !== false)
      .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
    const keep = list[0] || null;
    // Stop extras on server/client if an older Greg left multiple alive
    if (keep) {
      for (const meta of list.slice(1)) {
        try {
          await api("/api/session/stop", {
            method: "POST",
            body: JSON.stringify({ tabId: meta.tabId }),
          });
        } catch {
          /* ignore */
        }
      }
      const st = ensureTabState(keep);
      await loadTabTranscript(st);
      if (st.alive) connectStream(st);
      renderSessionList();
      if (!activeTabId) switchToTab(st.tabId);
      else if (activeTabId === st.tabId) {
        if (
          els.transcript &&
          ![...els.transcript.children].some((c) => c !== els.emptyState)
        ) {
          await loadTabTranscript(st);
        }
      }
    } else {
      renderSessionList();
    }
  } catch {
    /* first paint without list is fine */
  }
}

// ── Sidebar (desktop collapse + mobile drawer) ───────────────

/** Mobile / narrow layout: off-canvas drawer (matches CSS ≤820px). */
function isMobileSidebar() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 820px)").matches
  );
}

function syncSidebarChrome() {
  const mobile = isMobileSidebar();
  const drawerOpen = document.body.classList.contains("sidebar-open");
  const collapsed = document.body.classList.contains("sidebar-collapsed");
  if (els.btnSidebarOpen) {
    const expanded = mobile ? drawerOpen : !collapsed;
    els.btnSidebarOpen.setAttribute("aria-expanded", expanded ? "true" : "false");
    els.btnSidebarOpen.title = expanded ? "Hide sidebar" : "Show sidebar";
  }
}

function openSidebar() {
  if (isMobileSidebar()) {
    document.body.classList.add("sidebar-open");
    document.body.classList.remove("sidebar-collapsed");
    if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = false;
  } else {
    // Desktop: expand left column
    document.body.classList.remove("sidebar-collapsed");
    document.body.classList.remove("sidebar-open");
    if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
  }
  syncSidebarChrome();
}

/**
 * Dismiss mobile drawer only. Never collapses the desktop sidebar —
 * session/history picks used to call this and hide the left panel.
 */
function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
  syncSidebarChrome();
}

function toggleSidebar() {
  if (isMobileSidebar()) {
    if (document.body.classList.contains("sidebar-open")) closeSidebar();
    else openSidebar();
    return;
  }
  // Desktop: explicit hamburger collapse / expand only
  if (document.body.classList.contains("sidebar-collapsed")) {
    document.body.classList.remove("sidebar-collapsed");
  } else {
    document.body.classList.add("sidebar-collapsed");
  }
  document.body.classList.remove("sidebar-open");
  if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
  syncSidebarChrome();
}

// ── Events ───────────────────────────────────────────────────

if (els.transcript) {
  els.transcript.addEventListener(
    "scroll",
    () => updateTranscriptStickFromScroll(),
    { passive: true },
  );
}

els.btnNew.addEventListener("click", () => newSession());
els.btnSend.addEventListener("click", () => sendPrompt());

if (els.composerProject) {
  els.composerProject.addEventListener("click", () => openFolderPicker());
}
if (els.emptyCards) {
  els.emptyCards.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !els.emptyCards.contains(btn)) return;
    void handleEmptyCard(btn.getAttribute("data-action") || "");
  });
}

if (els.alwaysApprove) {
  els.alwaysApprove.addEventListener("change", () => scheduleSettingsSave());
}
if (els.model) {
  els.model.addEventListener("change", () => scheduleSettingsSave());
}
if (els.effort) {
  els.effort.addEventListener("change", () => scheduleSettingsSave());
}
if (els.defaultCwd) {
  els.defaultCwd.addEventListener("change", () => scheduleSettingsSave());
  els.defaultCwd.addEventListener("blur", () => scheduleSettingsSave());
}
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
  // Textarea may grow; keep transcript clear of the floating dock
  requestAnimationFrame(syncComposerOverlap);
});

/**
 * Transcript bottom padding tracks the floating composer height so content
 * can scroll under the transparent area while the dock alone occludes.
 */
function syncComposerOverlap() {
  if (!els.composer || !els.transcript) return;
  const h = Math.ceil(els.composer.getBoundingClientRect().height) || 168;
  els.transcript.style.setProperty("--composer-overlap", `${h}px`);
}

if (els.composer && typeof ResizeObserver === "function") {
  const ro = new ResizeObserver(() => syncComposerOverlap());
  ro.observe(els.composer);
}
syncComposerOverlap();
window.addEventListener("resize", () => syncComposerOverlap());

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
  if (isFolderPickerOpen()) {
    closeFolderPicker();
    e.preventDefault();
    return;
  }
  if (document.body.classList.contains("sidebar-open")) {
    closeSidebar();
    e.preventDefault();
    return;
  }
  if (filesPanelOpen) {
    setFilesPanelOpen(false);
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
  // Toggle: desktop collapse/expand, mobile drawer open/close
  els.btnSidebarOpen.addEventListener("click", () => toggleSidebar());
}
if (els.btnSidebarClose) {
  els.btnSidebarClose.addEventListener("click", () => closeSidebar());
}
if (els.sidebarBackdrop) {
  els.sidebarBackdrop.addEventListener("click", () => closeSidebar());
}
// Keep drawer/collapse coherent when rotating or resizing across 820px
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  const sidebarMq = window.matchMedia("(max-width: 820px)");
  const onSidebarMq = () => {
    if (sidebarMq.matches) {
      // Entering mobile: drop desktop collapse; drawer starts closed
      document.body.classList.remove("sidebar-collapsed");
      if (!document.body.classList.contains("sidebar-open")) {
        if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
      }
    } else {
      // Entering desktop: close drawer chrome
      document.body.classList.remove("sidebar-open");
      if (els.sidebarBackdrop) els.sidebarBackdrop.hidden = true;
    }
    syncSidebarChrome();
  };
  if (typeof sidebarMq.addEventListener === "function") {
    sidebarMq.addEventListener("change", onSidebarMq);
  } else if (typeof sidebarMq.addListener === "function") {
    sidebarMq.addListener(onSidebarMq);
  }
  syncSidebarChrome();
}

if (els.btnBrowseCwd) {
  els.btnBrowseCwd.addEventListener("click", () => openFolderPicker());
}
if (els.folderPickerBackdrop) {
  els.folderPickerBackdrop.addEventListener("click", () => closeFolderPicker());
}
if (els.folderPickerClose) {
  els.folderPickerClose.addEventListener("click", () => closeFolderPicker());
}
if (els.folderPickerCancel) {
  els.folderPickerCancel.addEventListener("click", () => closeFolderPicker());
}
if (els.folderPickerSelect) {
  els.folderPickerSelect.addEventListener("click", () => confirmFolderPicker());
}
if (els.folderPickerUp) {
  els.folderPickerUp.addEventListener("click", () => {
    if (pickerParent) void loadFolderPicker(pickerParent);
  });
}
if (els.folderPickerHome) {
  els.folderPickerHome.addEventListener("click", () => {
    void loadFolderPicker(pickerHome || "~");
  });
}
if (els.folderPickerNew) {
  els.folderPickerNew.addEventListener("click", () => {
    void createFolderInPicker();
  });
}
if (els.folderPickerDrive) {
  els.folderPickerDrive.addEventListener("change", () => {
    const v = els.folderPickerDrive.value;
    if (v) void loadFolderPicker(v);
  });
}

if (els.btnFiles) {
  els.btnFiles.addEventListener("click", () => toggleFilesPanel());
}
if (els.btnFilesClose) {
  els.btnFilesClose.addEventListener("click", () => setFilesPanelOpen(false));
}
if (els.btnFilesRefresh) {
  els.btnFilesRefresh.addEventListener("click", () => {
    if (filesPanelOpen) void refreshFilesTree();
  });
}

// ── Import Grok Build sessions (Phase 7) ─────────────────────────────

function openImportGrok() {
  if (!els.importGrok) return;
  els.importGrok.hidden = false;
  void loadImportGrokList();
}

function closeImportGrok() {
  if (!els.importGrok) return;
  els.importGrok.hidden = true;
}

async function loadImportGrokList() {
  if (!els.importGrokList) return;
  els.importGrokList.innerHTML = "";
  if (els.importGrokStatus) {
    els.importGrokStatus.textContent = "Loading Grok sessions…";
  }
  try {
    const data = await api("/api/import/grok?limit=80");
    const sessions = data.sessions || [];
    if (els.importGrokStatus) {
      els.importGrokStatus.textContent = sessions.length
        ? `${sessions.length} session${sessions.length === 1 ? "" : "s"} under ${data.rootDir || "~/.grok/sessions"}`
        : `No sessions found under ${data.rootDir || "~/.grok/sessions"}`;
    }
    for (const s of sessions) {
      const row = document.createElement("div");
      row.className = "import-grok-row";
      row.setAttribute("role", "option");

      const body = document.createElement("div");
      body.className = "import-grok-body";
      const title = document.createElement("div");
      title.className = "import-grok-title";
      title.textContent = s.title || s.cwdBase || s.id;
      title.title = s.id;
      const sub = document.createElement("div");
      sub.className = "import-grok-sub";
      const when = s.updatedAt
        ? new Date(s.updatedAt).toLocaleString()
        : "";
      sub.textContent = [s.cwdBase || s.cwd, when, s.model, s.kind]
        .filter(Boolean)
        .join(" · ");
      body.appendChild(title);
      body.appendChild(sub);

      if (s.imported) {
        const badge = document.createElement("span");
        badge.className = "import-grok-badge in";
        badge.textContent = "in Greg";
        row.appendChild(body);
        row.appendChild(badge);
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "btn subtle";
        openBtn.textContent = "Open";
        openBtn.addEventListener("click", () => {
          closeImportGrok();
          void openHistory(s.id);
        });
        row.appendChild(openBtn);
      } else {
        row.appendChild(body);
        const imp = document.createElement("button");
        imp.type = "button";
        imp.className = "btn primary";
        imp.textContent = "Import";
        imp.addEventListener("click", () => {
          void importGrokSession(s.id, imp, row);
        });
        row.appendChild(imp);
      }
      els.importGrokList.appendChild(row);
    }
  } catch (e) {
    if (els.importGrokStatus) {
      els.importGrokStatus.textContent = e.message || "Failed to list Grok sessions";
    }
  }
}

/**
 * @param {string} id
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} row
 */
async function importGrokSession(id, btn, row) {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "…";
  try {
    const data = await api("/api/import/grok", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    await refreshHistory();
    // Refresh row to "in Greg"
    const badge = document.createElement("span");
    badge.className = "import-grok-badge in";
    badge.textContent = "in Greg";
    btn.replaceWith(badge);
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn subtle";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => {
      closeImportGrok();
      void openHistory(data.id || id);
    });
    row.appendChild(openBtn);
    if (els.importGrokStatus) {
      els.importGrokStatus.textContent = `Imported “${data.title || id}” (${data.messageCount ?? "?"} messages)`;
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = prev;
    if (e.data?.code === "ALREADY_IMPORTED") {
      await refreshHistory();
      void loadImportGrokList();
      return;
    }
    alert(e.message || "Import failed");
  }
}

if (els.btnImportGrok) {
  els.btnImportGrok.addEventListener("click", () => openImportGrok());
}
if (els.importGrokClose) {
  els.importGrokClose.addEventListener("click", () => closeImportGrok());
}
if (els.importGrokDone) {
  els.importGrokDone.addEventListener("click", () => closeImportGrok());
}
if (els.importGrokBackdrop) {
  els.importGrokBackdrop.addEventListener("click", () => closeImportGrok());
}
if (els.importGrokRefresh) {
  els.importGrokRefresh.addEventListener("click", () => {
    void loadImportGrokList();
  });
}

loadMeta();
hydrateSessions();
void refreshHistory();
void refreshRecents();
setStatus("idle", "Idle");
setStopEnabled(false);
setComposerEnabled(false);
renderSessionList();
