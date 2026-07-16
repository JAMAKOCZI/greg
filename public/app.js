const $ = (id) => document.getElementById(id);

const els = {
  cwd: $("cwd"),
  meta: $("meta"),
  status: $("status"),
  statusText: $("status-text"),
  sessionLabel: $("session-label"),
  transcript: $("transcript"),
  prompt: $("prompt"),
  hint: $("hint"),
  btnNew: $("btn-new"),
  btnSend: $("btn-send"),
  alwaysApprove: $("always-approve"),
};

/** @type {string|null} */
let tabId = null;
/** @type {EventSource|null} */
let stream = null;
/** @type {HTMLElement|null} */
let liveAgentBubble = null;
/** @type {HTMLElement|null} */
let liveThoughtBubble = null;

function setStatus(kind, text) {
  els.status.className = `status ${kind}`;
  els.statusText.textContent = text;
}

function appendBubble(kind, text, { role } = {}) {
  const div = document.createElement("div");
  div.className = `bubble ${kind}`;
  if (role) {
    const r = document.createElement("span");
    r.className = "role";
    r.textContent = role;
    div.appendChild(r);
  }
  div.appendChild(document.createTextNode(text));
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
  return div;
}

function appendToLive(kind, chunk) {
  if (kind === "thought") {
    if (!liveThoughtBubble) {
      liveThoughtBubble = appendBubble("thought", "", { role: "thinking" });
    }
    liveThoughtBubble.appendChild(document.createTextNode(chunk));
  } else {
    if (!liveAgentBubble) {
      liveAgentBubble = appendBubble("agent", "", { role: "greg" });
    }
    liveAgentBubble.appendChild(document.createTextNode(chunk));
  }
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

function resetLive() {
  liveAgentBubble = null;
  liveThoughtBubble = null;
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
    els.cwd.value = meta.defaultCwd || "";
    els.meta.innerHTML = `
      <div><strong>greg</strong> v${meta.version}</div>
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
    .replaceAll(">", "&gt;");
}

function connectStream(id) {
  if (stream) {
    stream.close();
    stream = null;
  }
  stream = new EventSource(`/api/stream?tabId=${encodeURIComponent(id)}`);
  stream.addEventListener("hello", () => {
    /* connected */
  });
  stream.addEventListener("acp", (ev) => {
    try {
      handleAcp(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  stream.addEventListener("acp-request", (ev) => {
    try {
      handleAcpRequest(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  stream.addEventListener("stderr", (ev) => {
    try {
      const { text } = JSON.parse(ev.data);
      if (text?.trim()) appendBubble("system", text.trim());
    } catch {
      /* ignore */
    }
  });
  stream.addEventListener("error", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      appendBubble("system", data.message || "Agent error");
      setStatus("error", "Error");
    } catch {
      /* EventSource network error also fires "error" without data */
    }
  });
  stream.addEventListener("exit", (ev) => {
    try {
      const info = JSON.parse(ev.data);
      appendBubble("system", `Agent exited (code=${info.code})`);
      setStatus("idle", "Disconnected");
      setComposerEnabled(false);
    } catch {
      /* ignore */
    }
  });
}

function handleAcp(msg) {
  if (msg.method !== "session/update" && msg.method !== "x.ai/session/update") {
    // Still show unknown notifications lightly
    if (msg.method) {
      // ignore noise for now
    }
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
    if (chunk) appendToLive("agent", chunk);
    return;
  }
  if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    const chunk =
      update.content?.text ||
      update.text ||
      (typeof update.content === "string" ? update.content : "") ||
      "";
    if (chunk) appendToLive("thought", chunk);
    return;
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const title = update.title || update.toolCallId || update.toolName || "tool";
    const status = update.status || "";
    appendBubble(
      "tool",
      `${title}${status ? ` · ${status}` : ""}`,
      { role: "tool" },
    );
    return;
  }
  if (kind === "plan") {
    const entries = update.entries || update.plan || [];
    const text = Array.isArray(entries)
      ? entries.map((e) => `• ${e.content || e.title || JSON.stringify(e)}`).join("\n")
      : JSON.stringify(entries, null, 2);
    appendBubble("tool", text || "(plan)", { role: "plan" });
  }
}

async function handleAcpRequest(msg) {
  // Permission requests: show and optionally auto-answer
  const method = msg.method || "";
  appendBubble(
    "system",
    `Agent request: ${method}\n${JSON.stringify(msg.params || {}, null, 2).slice(0, 800)}`,
  );

  if (els.alwaysApprove.checked && msg.id != null) {
    try {
      await api("/api/permission", {
        method: "POST",
        body: JSON.stringify({
          tabId,
          id: msg.id,
          result: {
            outcome: { outcome: "selected", optionId: "allow-once" },
          },
        }),
      });
      appendBubble("system", "Auto-approved tool request");
    } catch (e) {
      appendBubble("system", `Auto-approve failed: ${e.message}`);
    }
  }
}

function setComposerEnabled(on) {
  els.prompt.disabled = !on;
  els.btnSend.disabled = !on;
  els.hint.textContent = on
    ? "Enter to send · Shift+Enter newline"
    : "Create a session to start";
}

async function newSession() {
  setStatus("busy", "Starting agent…");
  setComposerEnabled(false);
  resetLive();
  els.transcript.innerHTML = "";
  appendBubble("system", "Spawning grok agent stdio…");

  try {
    if (tabId) {
      try {
        await api("/api/session/stop", {
          method: "POST",
          body: JSON.stringify({ tabId }),
        });
      } catch {
        /* ignore */
      }
    }

    const data = await api("/api/session/new", {
      method: "POST",
      body: JSON.stringify({
        cwd: els.cwd.value.trim() || undefined,
        alwaysApprove: els.alwaysApprove.checked,
      }),
    });

    tabId = data.tabId;
    connectStream(tabId);
    els.sessionLabel.textContent = data.sessionId
      ? `session ${String(data.sessionId).slice(0, 8)}…`
      : `tab ${tabId.slice(0, 8)}…`;
    setStatus("ready", "Ready");
    setComposerEnabled(true);
    appendBubble("system", `Session ready · ${data.cwd}`);
    els.prompt.focus();
  } catch (e) {
    setStatus("error", "Failed");
    const hint = e.data?.hint ? `\n${e.data.hint}` : "";
    appendBubble("system", `${e.message}${hint}`);
  }
}

async function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text || !tabId) return;
  els.prompt.value = "";
  resetLive();
  appendBubble("user", text, { role: "you" });
  setStatus("busy", "Running…");
  els.btnSend.disabled = true;

  try {
    await api("/api/prompt", {
      method: "POST",
      body: JSON.stringify({ tabId, text }),
    });
    setStatus("ready", "Ready");
  } catch (e) {
    setStatus("error", "Error");
    appendBubble("system", e.message);
  } finally {
    els.btnSend.disabled = false;
    els.prompt.focus();
  }
}

els.btnNew.addEventListener("click", () => newSession());
els.btnSend.addEventListener("click", () => sendPrompt());
els.prompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

loadMeta();
setStatus("idle", "Idle");
