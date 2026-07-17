/**
 * Greg — local web workspace for Grok Build (ACP).
 * Binds to 127.0.0.1 only. Spawns `grok agent stdio` per browser tab.
 */
import { spawn } from "node:child_process";
import { platform } from "node:os";
import {
  createGregServer,
  newBootstrapToken,
  newSessionSecret,
  json,
  readJson,
} from "./lib/http.mjs";
import {
  AcpBridge,
  newClientSessionId,
  resolveGrokBin,
} from "./lib/acp-bridge.mjs";
import { TabRegistry } from "./lib/tabs.mjs";
import {
  TranscriptStore,
  defaultSessionsDir,
} from "./lib/transcript-store.mjs";
import {
  resolveWorkspace,
  RecentsStore,
  defaultRecentsPath,
} from "./lib/workspace.mjs";
import {
  SettingsStore,
  defaultSettingsPath,
} from "./lib/settings.mjs";
import {
  listTree,
  listDirectories,
  listFilesystemRoots,
  createDirectory,
  readWorkspaceFile,
  fsBrowseHttpStatus,
} from "./lib/fs-browse.mjs";
import { listAvailableModels, normalizeEffort } from "./lib/models.mjs";
import {
  applyContextSeed,
  buildResumeContextSeed,
} from "./lib/resume-context.mjs";
import {
  defaultGrokSessionsDir,
  grokSessionToTranscript,
  listGrokSessions,
  loadGrokSession,
} from "./lib/grok-sessions.mjs";
import { filterAgentStderrForUi } from "./lib/agent-stderr.mjs";

const PORT = Number(process.env.PORT || 0);
const HOST = "127.0.0.1";
const ENV_DEFAULT_CWD = process.env.GREG_CWD || process.cwd();
// Resolve relative GROK_BIN against Greg process cwd (not session workspace)
const GROK_BIN = resolveGrokBin(process.env.GROK_BIN || "grok");
const SESSIONS_DIR = process.env.GREG_SESSIONS_DIR || defaultSessionsDir();
const RECENTS_PATH = process.env.GREG_RECENTS_PATH || defaultRecentsPath();
const SETTINGS_PATH = process.env.GREG_SETTINGS_PATH || defaultSettingsPath();
const GROK_SESSIONS_DIR =
  process.env.GREG_GROK_SESSIONS_DIR || defaultGrokSessionsDir();

const tabs = new TabRegistry();
const transcripts = new TranscriptStore({ rootDir: SESSIONS_DIR });
const recents = new RecentsStore({ filePath: RECENTS_PATH });
const settingsStore = new SettingsStore({ filePath: SETTINGS_PATH });

/**
 * Effective default workspace: settings.defaultCwd if set, else env/cwd.
 * @returns {Promise<string>}
 */
async function effectiveDefaultCwd() {
  const s = await settingsStore.load();
  if (s.defaultCwd) return s.defaultCwd;
  return ENV_DEFAULT_CWD;
}

const bootstrapToken = newBootstrapToken();
const sessionSecret = newSessionSecret();

const server = createGregServer({
  bootstrapToken,
  sessionSecret,
  async onApi(req, res, url) {
    if (url.pathname === "/api/meta" && req.method === "GET") {
      try {
        const settings = await settingsStore.load();
        let modelsPayload = null;
        try {
          modelsPayload = await listAvailableModels();
        } catch {
          modelsPayload = null;
        }
        json(res, 200, {
          name: "greg",
          version: "0.8.0",
          grokBin: GROK_BIN,
          defaultCwd: await effectiveDefaultCwd(),
          sessionsDir: SESSIONS_DIR,
          platform: platform(),
          settings,
          models: modelsPayload?.models || [],
          modelsSource: modelsPayload?.source || "known",
          defaultModel: modelsPayload?.defaultModel || "grok-4.5",
        });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/models" && req.method === "GET") {
      try {
        const payload = await listAvailableModels();
        json(res, 200, payload);
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/settings" && req.method === "GET") {
      try {
        const settings = await settingsStore.load();
        json(res, 200, { settings });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/settings" && req.method === "PUT") {
      try {
        const body = await readJson(req);
        const patch = body.settings || body;
        // Validate defaultCwd when provided (empty clears)
        if (Object.prototype.hasOwnProperty.call(patch, "defaultCwd")) {
          const raw = patch.defaultCwd;
          if (raw != null && String(raw).trim()) {
            const resolved = await resolveWorkspace(String(raw));
            if (!resolved.ok) {
              json(res, 400, {
                error: resolved.error,
                code: resolved.code,
                field: "defaultCwd",
              });
              return true;
            }
            patch.defaultCwd = resolved.path;
          } else {
            patch.defaultCwd = null;
          }
        }
        const settings = await settingsStore.update(patch);
        json(res, 200, { ok: true, settings });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    // Recent workspaces (GET is read-only; missing dirs filtered in response)
    if (url.pathname === "/api/recents" && req.method === "GET") {
      try {
        const list = await recents.list({ hideMissing: true });
        json(res, 200, { recents: list });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/recents" && req.method === "POST") {
      const body = await readJson(req);
      try {
        const result = await recents.touch(body.path || "");
        if (!result.ok) {
          json(res, 400, { error: result.error, code: result.code });
          return true;
        }
        json(res, 200, { ok: true, path: result.path, recents: result.recents });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/recents" && req.method === "DELETE") {
      let body = {};
      try {
        body = await readJson(req);
      } catch {
        body = {};
      }
      const path = (body.path || url.searchParams.get("path") || "").trim();
      if (!path) {
        json(res, 400, {
          error: "Missing path",
          code: "EMPTY",
        });
        return true;
      }
      try {
        const removed = await recents.remove(path);
        json(res, 200, { ok: true, removed });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/workspace/resolve" && req.method === "POST") {
      const body = await readJson(req);
      const result = await resolveWorkspace(body.path || "");
      if (!result.ok) {
        json(res, 400, { error: result.error, code: result.code });
        return true;
      }
      json(res, 200, result);
      return true;
    }

    // Read-only filesystem browse (under workspace root only)
    if (url.pathname === "/api/fs/tree" && req.method === "GET") {
      try {
        const root =
          (url.searchParams.get("root") || "").trim() ||
          (await effectiveDefaultCwd());
        const path = (url.searchParams.get("path") || "").trim();
        const depthParam = url.searchParams.get("depth");
        const depth =
          depthParam != null && depthParam !== ""
            ? Number(depthParam)
            : undefined;
        const result = await listTree(root, path, {
          depth: Number.isFinite(depth) ? depth : undefined,
        });
        if (!result.ok) {
          json(res, fsBrowseHttpStatus(result.code), {
            error: result.error,
            code: result.code,
          });
          return true;
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/fs/file" && req.method === "GET") {
      try {
        const root =
          (url.searchParams.get("root") || "").trim() ||
          (await effectiveDefaultCwd());
        const path = (url.searchParams.get("path") || "").trim();
        const result = await readWorkspaceFile(root, path);
        if (!result.ok) {
          json(res, fsBrowseHttpStatus(result.code), {
            error: result.error,
            code: result.code,
          });
          return true;
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    // Directory picker (workspace chooser) — list dirs at an absolute path
    if (url.pathname === "/api/fs/dirs" && req.method === "GET") {
      try {
        const path =
          (url.searchParams.get("path") || "").trim() ||
          (await effectiveDefaultCwd());
        const result = await listDirectories(path);
        if (!result.ok) {
          json(res, fsBrowseHttpStatus(result.code), {
            error: result.error,
            code: result.code,
          });
          return true;
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/fs/roots" && req.method === "GET") {
      try {
        const result = await listFilesystemRoots();
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/fs/mkdir" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const parent =
          (body.path || body.parent || "").trim() ||
          (await effectiveDefaultCwd());
        const name = (body.name || "").trim();
        const result = await createDirectory(parent, name);
        if (!result.ok) {
          const status =
            result.code === "EEXIST"
              ? 409
              : result.code === "EACCES"
                ? 403
                : result.code === "INVALID_NAME"
                  ? 400
                  : fsBrowseHttpStatus(result.code);
          json(res, status, { error: result.error, code: result.code });
          return true;
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      json(res, 200, { tabs: tabs.list() });
      return true;
    }

    // History (durable transcripts)
    if (url.pathname === "/api/history" && req.method === "GET") {
      try {
        const list = await transcripts.list();
        json(res, 200, { sessions: list });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    // Phase 7: read-only import from ~/.grok/sessions (never writes there)
    if (url.pathname === "/api/import/grok" && req.method === "GET") {
      try {
        const limitRaw = Number(url.searchParams.get("limit"));
        const list = await listGrokSessions({
          rootDir: GROK_SESSIONS_DIR,
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        });
        // Mark which ones already exist in Greg
        const gregList = await transcripts.list();
        const gregIds = new Set(gregList.map((s) => s.id));
        const importedSourceIds = new Set(
          gregList
            .filter((s) => s.source === "grok" && s.sourceSessionId)
            .map((s) => s.sourceSessionId),
        );
        json(res, 200, {
          rootDir: GROK_SESSIONS_DIR,
          sessions: list.map((s) => ({
            ...s,
            imported:
              gregIds.has(s.id) || importedSourceIds.has(s.id),
          })),
        });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/import/grok" && req.method === "POST") {
      try {
        const body = await readJson(req);
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) {
          json(res, 400, { error: "Missing id", code: "MISSING_ID" });
          return true;
        }
        const force = body.force === true;
        const existing = await transcripts.load(id);
        if (existing && !force) {
          json(res, 409, {
            error: "Already imported (same id in Greg history)",
            code: "ALREADY_IMPORTED",
            id,
            title: existing.title,
          });
          return true;
        }
        if (existing && tabs.has(id)) {
          json(res, 409, {
            error: "Session is live — stop it before re-importing",
            code: "LIVE",
          });
          return true;
        }

        const loaded = await loadGrokSession(id, {
          rootDir: GROK_SESSIONS_DIR,
        });
        if (!loaded) {
          json(res, 404, {
            error: "Grok session not found",
            code: "NOT_FOUND",
            hint: `Looked under ${GROK_SESSIONS_DIR}`,
          });
          return true;
        }

        const doc = grokSessionToTranscript(loaded.summary, loaded.items, {
          id,
        });
        await transcripts.save(doc);
        json(res, 200, {
          ok: true,
          id: doc.id,
          title: doc.title,
          cwd: doc.cwd,
          messageCount: doc.messages.length,
          source: doc.source,
          overwritten: Boolean(existing),
        });
      } catch (err) {
        json(res, 500, { error: err.message || String(err) });
      }
      return true;
    }

    {
      const m = url.pathname.match(/^\/api\/history\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (req.method === "GET") {
          try {
            const doc = await transcripts.load(id);
            if (!doc) {
              json(res, 404, { error: "Unknown history session" });
              return true;
            }
            json(res, 200, doc);
          } catch (err) {
            json(res, 400, { error: err.message || String(err) });
          }
          return true;
        }
        if (req.method === "DELETE") {
          if (tabs.has(id)) {
            json(res, 409, {
              error: "Session is still live — stop it before deleting history",
            });
            return true;
          }
          try {
            const deleted = await transcripts.delete(id);
            json(res, 200, { ok: true, deleted });
          } catch (err) {
            json(res, 400, { error: err.message || String(err) });
          }
          return true;
        }
      }
    }

    // GET /api/session/:tabId
    {
      const m = url.pathname.match(/^\/api\/session\/([^/]+)$/);
      if (m && req.method === "GET") {
        const tabId = decodeURIComponent(m[1]);
        const meta = tabs.meta(tabId);
        if (!meta) {
          json(res, 404, { error: "Unknown tab" });
          return true;
        }
        json(res, 200, meta);
        return true;
      }
    }

    if (url.pathname === "/api/session/new" && req.method === "POST") {
      const body = await readJson(req);
      const settings = await settingsStore.load();
      const fallbackCwd = await effectiveDefaultCwd();
      const cwdInput = (body.cwd || fallbackCwd || "").trim() || fallbackCwd;
      const resolved = await resolveWorkspace(cwdInput);
      if (!resolved.ok) {
        json(res, 400, {
          error: resolved.error,
          code: resolved.code,
          hint: "Pick an existing project directory",
        });
        return true;
      }
      const cwd = resolved.path;

      // Client may send tabId only to reconnect/replace that tab; otherwise always create new.
      const tabId = body.tabId || newClientSessionId();
      const existing = tabs.get(tabId);
      if (existing) {
        await flushThoughtBuffer(tabId, existing);
        await flushAgentBuffer(tabId, existing);
        existing.bridge.stop();
        endSse(existing);
        tabs.delete(tabId);
      }

      // Explicit body fields override settings; empty falls back to product defaults
      let model = settings.model || "grok-4.5";
      if (Object.prototype.hasOwnProperty.call(body, "model")) {
        model =
          typeof body.model === "string" && body.model.trim()
            ? body.model.trim()
            : "grok-4.5";
      }
      let effort = normalizeEffort(settings.effort) || "high";
      if (
        Object.prototype.hasOwnProperty.call(body, "effort") ||
        Object.prototype.hasOwnProperty.call(body, "reasoningEffort")
      ) {
        const raw = Object.prototype.hasOwnProperty.call(body, "effort")
          ? body.effort
          : body.reasoningEffort;
        effort = normalizeEffort(raw) || "high";
      }
      let alwaysApprove = settings.alwaysApprove;
      if (Object.prototype.hasOwnProperty.call(body, "alwaysApprove")) {
        alwaysApprove = body.alwaysApprove === true;
      }

      const bridge = new AcpBridge({
        grokBin: GROK_BIN,
        cwd,
        model,
        effort,
        alwaysApprove,
      });
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : null;
      const entry = tabs.create(tabId, { bridge, cwd, title });
      entry.agentBuffer = "";
      entry.thoughtBuffer = "";
      wireBridge(tabId, entry);

      const resume = body.resume === true;
      try {
        const result = await bridge.openSession({ cwd });
        tabs.touch(tabId);
        // Product rule: only one live agent at a time (others go to history)
        await stopOtherLiveTabs(tabId);
        try {
          await ensureTranscript(tabId, {
            cwd,
            title: entry.title,
            createdAt: entry.createdAt,
            // Replacing a live tab, or resuming a saved chat under the same id
            restarted: Boolean(existing) || resume,
            restartNote: resume
              ? "Session resumed — continue in this chat"
              : existing
                ? "Session restarted"
                : undefined,
          });
        } catch (persistErr) {
          console.error("[greg] transcript create failed", persistErr);
        }

        // Fresh ACP session has empty model context — seed from Greg transcript
        // for resume / tab restart so the first real prompt continues the chat.
        /** @type {{ messageCount: number, charCount: number, truncated: boolean } | null} */
        let contextSeedMeta = null;
        if (resume || existing) {
          try {
            const doc = await transcripts.load(tabId);
            const built = buildResumeContextSeed(doc?.messages || []);
            if (built?.text) {
              entry.contextSeed = built.text;
              contextSeedMeta = {
                messageCount: built.messageCount,
                charCount: built.charCount,
                truncated: built.truncated,
              };
            }
          } catch (seedErr) {
            console.error("[greg] resume context seed failed", seedErr);
          }
        }

        try {
          await recents.touch(cwd, { skipValidate: true });
        } catch (recErr) {
          console.error("[greg] recents touch failed", recErr);
        }
        json(res, 200, {
          tabId,
          sessionId: bridge.sessionId,
          cwd,
          title: entry.title,
          createdAt: entry.createdAt,
          lastActiveAt: entry.lastActiveAt,
          resumed: resume,
          contextSeeded: Boolean(contextSeedMeta),
          contextSeed: contextSeedMeta,
          result,
        });
      } catch (err) {
        bridge.stop();
        endSse(entry);
        tabs.delete(tabId);
        json(res, 502, {
          error: err.message || String(err),
          hint: "Is `grok` installed and authenticated? Try: grok login",
        });
      }
      return true;
    }

    if (
      (url.pathname === "/api/session/title" && req.method === "POST") ||
      (url.pathname === "/api/session" && req.method === "PATCH")
    ) {
      const body = await readJson(req);
      const entry = tabs.setTitle(
        body.tabId,
        typeof body.title === "string" ? body.title : null,
      );
      if (!entry) {
        json(res, 404, { error: "Unknown tab" });
        return true;
      }
      void transcripts.setTitle(body.tabId, entry.title).catch(() => {});
      json(res, 200, { ok: true, ...tabs.meta(body.tabId) });
      return true;
    }

    if (url.pathname === "/api/prompt" && req.method === "POST") {
      const body = await readJson(req);
      const entry = tabs.get(body.tabId);
      if (!entry) {
        json(res, 404, { error: "Unknown tab — create a session first" });
        return true;
      }
      if (entry.bridge.hasPendingRequest) {
        json(res, 409, {
          error: "A turn is already in progress on this session",
          code: "BUSY",
        });
        return true;
      }
      const text = (body.text || "").trim();
      if (!text) {
        json(res, 400, { error: "Empty prompt" });
        return true;
      }
      tabs.ensureTitleFromPrompt(body.tabId, text);
      const title = entry.title;
      try {
        // Persist only the real user text — never the context seed preamble
        await persistMessage(body.tabId, entry, { role: "user", text }, { title });
      } catch (persistErr) {
        console.error("[greg] transcript user append failed", persistErr);
      }

      // One-shot: attach Greg transcript seed to the first prompt after resume
      const seedText =
        typeof entry.contextSeed === "string" ? entry.contextSeed : "";
      if (seedText) {
        entry.contextSeed = null;
      }
      const agentText = applyContextSeed(text, seedText || null);

      try {
        // Fire and stream via SSE; resolve when turn completes
        const result = await entry.bridge.prompt(agentText);
        tabs.touch(body.tabId);
        await flushThoughtBuffer(body.tabId, entry);
        await flushAgentBuffer(body.tabId, entry);
        if (result?.stopReason === "cancelled") {
          try {
            await persistMessage(body.tabId, entry, {
              role: "system",
              text: "Turn cancelled",
            });
          } catch {
            /* ignore */
          }
        }
        if (title) {
          void transcripts.setTitle(body.tabId, title).catch(() => {});
        }
        const meta = tabs.meta(body.tabId);
        json(res, 200, {
          ok: true,
          result,
          title: meta?.title ?? entry.title,
          lastActiveAt: meta?.lastActiveAt ?? entry.lastActiveAt,
        });
      } catch (err) {
        await flushThoughtBuffer(body.tabId, entry);
        await flushAgentBuffer(body.tabId, entry);
        try {
          await persistMessage(body.tabId, entry, {
            role: "system",
            text: err.message || String(err),
          });
        } catch {
          /* ignore */
        }
        json(res, 502, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/permission" && req.method === "POST") {
      const body = await readJson(req);
      const entry = tabs.get(body.tabId);
      if (!entry) {
        json(res, 404, { error: "Unknown tab" });
        return true;
      }
      if (body.error) {
        entry.bridge.respondError(body.id, body.error);
      } else {
        entry.bridge.respond(
          body.id,
          body.result ?? { outcome: { outcome: "selected", optionId: "allow-once" } },
        );
      }
      json(res, 200, { ok: true });
      return true;
    }

    // Interrupt in-flight turn (ACP session/cancel) — keeps session open
    if (url.pathname === "/api/cancel" && req.method === "POST") {
      const body = await readJson(req);
      const entry = tabs.get(body.tabId);
      if (!entry) {
        json(res, 404, { error: "Unknown tab" });
        return true;
      }
      try {
        const hadPending = entry.bridge.hasPendingRequest;
        const result = entry.bridge.cancel({
          reason: typeof body.reason === "string" ? body.reason : "user",
        });
        tabs.touch(body.tabId);
        json(res, 200, {
          ok: true,
          hadPending,
          ...result,
        });
      } catch (err) {
        json(res, 502, { error: err.message || String(err) });
      }
      return true;
    }

    if (url.pathname === "/api/stream" && req.method === "GET") {
      const tabId = url.searchParams.get("tabId");
      const entry = tabs.get(tabId);
      if (!entry) {
        json(res, 404, { error: "Unknown tab" });
        return true;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ tabId })}\n\n`);
      entry.sse.add(res);
      req.on("close", () => {
        entry.sse.delete(res);
      });
      return true;
    }

    if (url.pathname === "/api/session/stop" && req.method === "POST") {
      const body = await readJson(req);
      const entry = tabs.get(body.tabId);
      if (entry) {
        await flushThoughtBuffer(body.tabId, entry);
        await flushAgentBuffer(body.tabId, entry);
        entry.bridge.stop();
        endSse(entry);
        tabs.delete(body.tabId);
      }
      json(res, 200, { ok: true });
      return true;
    }

    return false;
  },
});

/**
 * @param {{ sse: Set<import('node:http').ServerResponse> }} entry
 */
function endSse(entry) {
  for (const s of entry.sse) {
    try {
      s.end();
    } catch {
      /* ignore */
    }
  }
  entry.sse.clear();
}

/**
 * Keep a single live agent process. Stop/flush every tab except `keepTabId`.
 * @param {string} keepTabId
 */
async function stopOtherLiveTabs(keepTabId) {
  for (const meta of tabs.list()) {
    if (meta.tabId === keepTabId) continue;
    const other = tabs.get(meta.tabId);
    if (!other) continue;
    try {
      await flushThoughtBuffer(meta.tabId, other);
      await flushAgentBuffer(meta.tabId, other);
    } catch {
      /* best-effort flush */
    }
    try {
      other.bridge.stop();
    } catch {
      /* ignore */
    }
    endSse(other);
    tabs.delete(meta.tabId);
  }
}

/**
 * @param {string} tabId
 * @param {{ cwd: string, title?: string|null, createdAt?: number, restarted?: boolean }} opts
 */
async function ensureTranscript(tabId, opts) {
  // Never overwrite: concurrent tool/plan upserts at session start must not wipe messages
  const existingBefore = await transcripts.load(tabId);
  const doc = await transcripts.ensure({
    id: tabId,
    cwd: opts.cwd,
    title: opts.title ?? null,
    createdAt: opts.createdAt,
  });
  if (opts.restarted && existingBefore) {
    await transcripts.appendMessage(tabId, {
      role: "system",
      text:
        typeof opts.restartNote === "string" && opts.restartNote.trim()
          ? opts.restartNote.trim()
          : "Session restarted",
    });
  }
  if (opts.title) await transcripts.setTitle(tabId, opts.title);
  // Keep cwd fresh on resume into same transcript id
  if (existingBefore && opts.cwd && existingBefore.cwd !== opts.cwd) {
    try {
      const full = await transcripts.load(tabId);
      if (full) {
        full.cwd = opts.cwd;
        await transcripts.save(full);
      }
    } catch {
      /* non-fatal */
    }
  }
  return doc;
}

/**
 * Append with auto-recreate if the file was deleted while the tab is live.
 * @param {string} tabId
 * @param {import('./lib/tabs.mjs').TabEntry} entry
 * @param {{ role: string, text: string, meta?: object }} message
 * @param {{ title?: string|null }} [opts]
 */
async function persistMessage(tabId, entry, message, opts = {}) {
  let doc = await transcripts.appendMessage(tabId, message, opts);
  if (doc) return doc;
  await ensureTranscript(tabId, {
    cwd: entry.cwd,
    title: entry.title,
    createdAt: entry.createdAt,
  });
  doc = await transcripts.appendMessage(tabId, message, opts);
  if (!doc) {
    console.error("[greg] transcript append still missing after ensure", tabId);
  }
  return doc;
}

/**
 * @param {string} tabId
 * @param {import('./lib/tabs.mjs').TabEntry & { agentBuffer?: string, thoughtBuffer?: string }} entry
 */
async function flushAgentBuffer(tabId, entry) {
  const raw = String(entry.agentBuffer || "");
  if (!raw.trim()) {
    entry.agentBuffer = "";
    return;
  }
  try {
    await persistMessage(tabId, entry, { role: "agent", text: raw });
    entry.agentBuffer = "";
  } catch (err) {
    console.error("[greg] transcript agent flush failed", err);
    // keep buffer for retry on stop/shutdown
  }
}

/**
 * @param {string} tabId
 * @param {import('./lib/tabs.mjs').TabEntry & { thoughtBuffer?: string }} entry
 */
async function flushThoughtBuffer(tabId, entry) {
  const raw = String(entry.thoughtBuffer || "");
  if (!raw.trim()) {
    entry.thoughtBuffer = "";
    return;
  }
  try {
    await persistMessage(tabId, entry, {
      role: "thought",
      text: raw,
      meta: { kind: "thought" },
    });
    entry.thoughtBuffer = "";
  } catch (err) {
    console.error("[greg] transcript thought flush failed", err);
  }
}

/**
 * @param {string} tabId
 * @param {import('./lib/tabs.mjs').TabEntry & { agentBuffer?: string, thoughtBuffer?: string }} entry
 * @param {object} msg
 */
function recordAcpForTranscript(tabId, entry, msg) {
  if (msg.method !== "session/update" && msg.method !== "x.ai/session/update") {
    return;
  }
  const params = msg.params || {};
  const update = params.update || params.sessionUpdate || params;
  // Never use tool category `kind` (read/edit) as session update type
  const kind = update.sessionUpdate || update.type || "";

  if (kind === "agent_message_chunk" || kind === "agent_message") {
    const chunk =
      update.content?.text ||
      update.text ||
      update.message?.text ||
      (typeof update.content === "string" ? update.content : "") ||
      "";
    if (chunk) entry.agentBuffer = (entry.agentBuffer || "") + chunk;
    return;
  }

  if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    const chunk =
      update.content?.text ||
      update.text ||
      (typeof update.content === "string" ? update.content : "") ||
      "";
    if (chunk) entry.thoughtBuffer = (entry.thoughtBuffer || "") + chunk;
    return;
  }

  if (kind === "tool_call" || kind === "tool_call_update") {
    // Flush text buffers so history order matches interleaving
    void flushThoughtBuffer(tabId, entry).then(() =>
      flushAgentBuffer(tabId, entry),
    );
    const title =
      update.title || update.toolCallId || update.toolName || update.kind || "tool";
    const status = update.status || "";
    const text = `${title}${status ? ` · ${status}` : ""}`;
    const toolCallId = update.toolCallId || update.tool_call_id || null;
    void transcripts
      .upsertToolMessage(tabId, {
        text,
        meta: {
          toolCallId,
          status: status || null,
          kind: update.kind || null,
        },
      })
      .then(async (doc) => {
        if (!doc) {
          await ensureTranscript(tabId, {
            cwd: entry.cwd,
            title: entry.title,
            createdAt: entry.createdAt,
          });
          await transcripts.upsertToolMessage(tabId, {
            text,
            meta: {
              toolCallId,
              status: status || null,
              kind: update.kind || null,
            },
          });
        }
      })
      .catch(() => {});
    return;
  }

  if (kind === "plan") {
    void flushThoughtBuffer(tabId, entry).then(() =>
      flushAgentBuffer(tabId, entry),
    );
    const entries = update.entries || update.plan || [];
    const text = Array.isArray(entries)
      ? entries
          .map((e) => `• ${e.content || e.title || JSON.stringify(e)}`)
          .join("\n")
      : JSON.stringify(entries);
    void transcripts
      .upsertPlanMessage(tabId, text || "(plan)")
      .then(async (doc) => {
        if (!doc) {
          await ensureTranscript(tabId, {
            cwd: entry.cwd,
            title: entry.title,
            createdAt: entry.createdAt,
          });
          await transcripts.upsertPlanMessage(tabId, text || "(plan)");
        }
      })
      .catch(() => {});
    return;
  }

  if (kind === "diff_review") {
    void flushThoughtBuffer(tabId, entry).then(() =>
      flushAgentBuffer(tabId, entry),
    );
    const content = Array.isArray(update.content) ? update.content : [];
    const paths = content
      .map((c) => (c && typeof c === "object" ? c.path : null))
      .filter(Boolean);
    const text =
      paths.length > 0
        ? `Diff review · ${paths.join(", ")}`
        : "Diff review";
    void transcripts
      .upsertToolMessage(tabId, {
        text,
        meta: { kind: "diff_review", paths },
      })
      .then(async (doc) => {
        if (!doc) {
          await ensureTranscript(tabId, {
            cwd: entry.cwd,
            title: entry.title,
            createdAt: entry.createdAt,
          });
          await transcripts.upsertToolMessage(tabId, {
            text,
            meta: { kind: "diff_review", paths },
          });
        }
      })
      .catch(() => {});
  }
}

/**
 * @param {string} tabId
 * @param {import('./lib/tabs.mjs').TabEntry & { agentBuffer?: string }} entry
 */
function wireBridge(tabId, entry) {
  const { bridge } = entry;
  /** @returns {boolean} true if this bridge is still the live tab bridge */
  const isCurrent = () => {
    const cur = tabs.get(tabId);
    return Boolean(cur && cur.bridge === bridge);
  };
  const push = (event, data) => {
    if (!isCurrent()) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of entry.sse) {
      try {
        res.write(payload);
      } catch {
        entry.sse.delete(res);
      }
    }
  };

  bridge.on("notification", (msg) => {
    if (!isCurrent()) return;
    recordAcpForTranscript(tabId, entry, msg);
    push("acp", msg);
  });
  bridge.on("request", (msg) => {
    if (!isCurrent()) return;
    const method = msg.method || "request";
    void persistMessage(tabId, entry, {
      role: "permission",
      text: `Agent request: ${method}`,
      meta: { id: msg.id ?? null, method },
    }).catch(() => {});
    push("acp-request", msg);
  });
  bridge.on("stderr", (text) => {
    if (!isCurrent()) return;
    // Drop non-fatal harness noise (MCP OAuth worker, ACP method-not-found, …)
    const cleaned = filterAgentStderrForUi(text);
    if (!cleaned) return;
    push("stderr", { text: cleaned });
  });
  bridge.on("error", (err) => {
    if (!isCurrent()) return;
    push("error", { message: err.message });
  });
  bridge.on("exit", (info) => {
    if (!isCurrent()) return;
    tabs.touch(tabId);
    void flushThoughtBuffer(tabId, entry).then(() =>
      flushAgentBuffer(tabId, entry),
    );
    push("exit", info);
  });
}

server.listen(PORT, HOST, () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  const url = `http://${HOST}:${port}/?token=${bootstrapToken}`;
  console.log("");
  console.log("  Greg — local web workspace for Grok Build");
  console.log(`  Open once:  ${url}`);
  effectiveDefaultCwd().then((cwd) => {
    console.log(`  Workspace:  ${cwd}`);
  });
  console.log(`  Grok bin:   ${GROK_BIN}`);
  console.log(`  History:    ${SESSIONS_DIR}`);
  console.log(`  Settings:   ${SETTINGS_PATH}`);
  console.log("");

  if (!process.env.GREG_NO_OPEN) {
    openBrowser(url);
  }
});

function openBrowser(url) {
  const p = platform();
  try {
    if (p === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" });
    else if (p === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  } catch {
    /* optional */
  }
}

async function shutdown() {
  const flushes = [];
  for (const [tabId, entry] of tabs.entries()) {
    flushes.push(
      flushThoughtBuffer(tabId, entry)
        .then(() => flushAgentBuffer(tabId, entry))
        .catch((err) => console.error("[greg] shutdown flush failed", err)),
    );
  }
  await Promise.allSettled(flushes);
  for (const [, entry] of tabs.entries()) {
    try {
      entry.bridge.stop();
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1200).unref();
  });
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
