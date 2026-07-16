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
import { AcpBridge, newClientSessionId } from "./lib/acp-bridge.mjs";
import { TabRegistry } from "./lib/tabs.mjs";

const PORT = Number(process.env.PORT || 0);
const HOST = "127.0.0.1";
const DEFAULT_CWD = process.env.GREG_CWD || process.cwd();
const GROK_BIN = process.env.GROK_BIN || "grok";

const tabs = new TabRegistry();

const bootstrapToken = newBootstrapToken();
const sessionSecret = newSessionSecret();

const server = createGregServer({
  bootstrapToken,
  sessionSecret,
  async onApi(req, res, url) {
    if (url.pathname === "/api/meta" && req.method === "GET") {
      json(res, 200, {
        name: "greg",
        version: "0.2.1",
        grokBin: GROK_BIN,
        defaultCwd: DEFAULT_CWD,
        platform: platform(),
      });
      return true;
    }

    if (url.pathname === "/api/sessions" && req.method === "GET") {
      json(res, 200, { tabs: tabs.list() });
      return true;
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
      const cwd = body.cwd || DEFAULT_CWD;
      // Client may send tabId only to reconnect/replace that tab; otherwise always create new.
      const tabId = body.tabId || newClientSessionId();
      const existing = tabs.get(tabId);
      if (existing) {
        existing.bridge.stop();
        endSse(existing);
        tabs.delete(tabId);
      }

      const bridge = new AcpBridge({
        grokBin: GROK_BIN,
        cwd,
        model: body.model || null,
        alwaysApprove: Boolean(body.alwaysApprove),
      });
      const title =
        typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : null;
      const entry = tabs.create(tabId, { bridge, cwd, title });
      wireBridge(tabId, entry);

      try {
        const result = await bridge.openSession({ cwd });
        tabs.touch(tabId);
        json(res, 200, {
          tabId,
          sessionId: bridge.sessionId,
          cwd,
          title: entry.title,
          createdAt: entry.createdAt,
          lastActiveAt: entry.lastActiveAt,
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
      const text = (body.text || "").trim();
      if (!text) {
        json(res, 400, { error: "Empty prompt" });
        return true;
      }
      tabs.ensureTitleFromPrompt(body.tabId, text);
      try {
        // Fire and stream via SSE; resolve when turn completes
        const result = await entry.bridge.prompt(text);
        tabs.touch(body.tabId);
        const meta = tabs.meta(body.tabId);
        json(res, 200, {
          ok: true,
          result,
          title: meta?.title ?? entry.title,
          lastActiveAt: meta?.lastActiveAt ?? entry.lastActiveAt,
        });
      } catch (err) {
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
 * @param {string} tabId
 * @param {import('./lib/tabs.mjs').TabEntry} entry
 */
function wireBridge(tabId, entry) {
  const { bridge } = entry;
  const push = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of entry.sse) {
      try {
        res.write(payload);
      } catch {
        entry.sse.delete(res);
      }
    }
  };

  bridge.on("notification", (msg) => push("acp", msg));
  bridge.on("request", (msg) => push("acp-request", msg));
  bridge.on("stderr", (text) => push("stderr", { text }));
  bridge.on("error", (err) => push("error", { message: err.message }));
  bridge.on("exit", (info) => {
    // Keep tab until client stops it; refresh activity for list UI.
    tabs.touch(tabId);
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
  console.log(`  Workspace:  ${DEFAULT_CWD}`);
  console.log(`  Grok bin:   ${GROK_BIN}`);
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

function shutdown() {
  for (const [, entry] of tabs.entries()) {
    entry.bridge.stop();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
