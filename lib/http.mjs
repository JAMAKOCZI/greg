import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function newBootstrapToken() {
  return randomBytes(24).toString("base64url");
}

export function newSessionSecret() {
  return randomBytes(32).toString("base64url");
}

/**
 * Minimal local-only HTTP helper.
 * @param {{
 *   publicDir?: string,
 *   bootstrapToken: string,
 *   sessionSecret: string,
 *   onApi: (req, res, url, ctx) => Promise<boolean|void> | boolean | void,
 * }} opts
 */
export function createGregServer(opts) {
  const publicDir = opts.publicDir || PUBLIC_DIR;
  const bootstrapToken = opts.bootstrapToken;
  let cookieValue = null;

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host || "127.0.0.1";
      if (!isLocalHost(host)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Greg only accepts localhost connections.");
        return;
      }

      const url = new URL(req.url || "/", `http://${host}`);

      // One-time bootstrap: ?token=… → Set-Cookie → redirect
      if (url.pathname === "/" && url.searchParams.has("token")) {
        const token = url.searchParams.get("token");
        if (token === bootstrapToken && !cookieValue) {
          cookieValue = opts.sessionSecret;
          res.writeHead(302, {
            Location: "/",
            "Set-Cookie": cookie(
              "greg_session",
              cookieValue,
              /* httpOnly */ true,
            ),
            "Cache-Control": "no-store",
          });
          res.end();
          return;
        }
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Invalid or already-used bootstrap token. Restart Greg.");
        return;
      }

      setSecurityHeaders(res);

      const authed = parseCookie(req.headers.cookie).greg_session === cookieValue;
      if (!authed && url.pathname !== "/healthz") {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("Unauthorized. Open the one-time URL printed by `npm start`.");
        return;
      }

      if (url.pathname === "/healthz") {
        json(res, 200, { ok: true, name: "greg" });
        return;
      }

      const handled = await opts.onApi(req, res, url, {
        authed,
        cookieValue,
      });
      if (handled) return;

      await serveStatic(req, res, url, publicDir);
    } catch (err) {
      console.error("[greg] request error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error");
      }
    }
  });

  return server;
}

function isLocalHost(hostHeader) {
  const host = hostHeader.split(":")[0].toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
  );
}

function cookie(name, value, httpOnly) {
  const parts = [
    `${name}=${value}`,
    "Path=/",
    "SameSite=Strict",
    // Secure only breaks on plain http://127.0.0.1 — skip for local dev
  ];
  if (httpOnly) parts.push("HttpOnly");
  return parts.join("; ");
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

export function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = 8 * 1024 * 1024;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function serveStatic(req, res, url, publicDir) {
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, rel);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=60",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}
