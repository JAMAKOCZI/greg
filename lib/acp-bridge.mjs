/**
 * Thin JSON-RPC over stdio bridge to `grok agent stdio`.
 * One Agent child process per Greg tab/session.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const DEFAULT_GROK = process.env.GROK_BIN || "grok";

export class AcpBridge extends EventEmitter {
  /**
   * @param {{ grokBin?: string, cwd?: string, model?: string, alwaysApprove?: boolean }} opts
   */
  constructor(opts = {}) {
    super();
    this.grokBin = opts.grokBin || DEFAULT_GROK;
    this.cwd = opts.cwd || process.cwd();
    this.model = opts.model || null;
    this.alwaysApprove = Boolean(opts.alwaysApprove);
    this.child = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    this.initialized = false;
    this.alive = false;
  }

  start() {
    if (this.child) return;

    const args = ["agent"];
    if (this.model) args.push("-m", this.model);
    if (this.alwaysApprove) args.push("--always-approve");
    args.push("stdio");

    this.child = spawn(this.grokBin, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Prefer interactive login cache over accidental API key billing
        // unless the user explicitly set keys for Greg.
      },
    });
    this.alive = true;

    this.rl = createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.#onLine(line));

    this.child.stderr.on("data", (buf) => {
      const text = buf.toString("utf8");
      this.emit("stderr", text);
    });

    this.child.on("error", (err) => {
      this.alive = false;
      this.emit("error", err);
      this.#rejectAll(err);
    });

    this.child.on("exit", (code, signal) => {
      this.alive = false;
      this.emit("exit", { code, signal });
      this.#rejectAll(
        new Error(`grok agent exited (code=${code}, signal=${signal})`),
      );
    });
  }

  stop() {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.child = null;
    this.alive = false;
    this.initialized = false;
    this.sessionId = null;
  }

  /**
   * Full ACP handshake + new session in `cwd`.
   * @param {{ cwd?: string, mcpServers?: object[] }} opts
   */
  async openSession(opts = {}) {
    this.start();
    const cwd = opts.cwd || this.cwd;

    if (!this.initialized) {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
        clientInfo: {
          name: "greg",
          version: "0.1.0",
        },
      });
      // Some agents expect an explicit initialized notification.
      this.notify("initialized", {});
      this.initialized = true;
    }

    const result = await this.request("session/new", {
      cwd,
      mcpServers: opts.mcpServers || [],
    });
    this.sessionId = result?.sessionId || result?.session_id || null;
    this.cwd = cwd;
    return result;
  }

  /**
   * @param {string} text
   * @param {{ sessionId?: string }} opts
   */
  async prompt(text, opts = {}) {
    const sessionId = opts.sessionId || this.sessionId;
    if (!sessionId) throw new Error("No ACP session — call openSession first");
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  /**
   * Respond to a permission request from the agent.
   * @param {string|number} id JSON-RPC id of the request
   * @param {object} result
   */
  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  /**
   * @param {string|number} id
   * @param {{ code: number, message: string }} error
   */
  respondError(id, error) {
    this.#write({ jsonrpc: "2.0", id, error });
  }

  /**
   * @param {string} method
   * @param {object} params
   * @returns {Promise<any>}
   */
  request(method, params = {}) {
    if (!this.child?.stdin) {
      return Promise.reject(new Error("Agent process is not running"));
    }
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method}`));
      }, 30 * 60 * 1000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write(payload);
    });
  }

  /**
   * @param {string} method
   * @param {object} params
   */
  notify(method, params = {}) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(obj) {
    if (!this.child?.stdin?.writable) {
      throw new Error("Agent stdin is not writable");
    }
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit("raw", trimmed);
      return;
    }

    // Response to our request
    if (msg.id != null && (msg.result !== undefined || msg.error)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(
            new Error(msg.error.message || JSON.stringify(msg.error)),
          );
        } else {
          pending.resolve(msg.result);
        }
      }
      this.emit("response", msg);
      return;
    }

    // Server → client request (permissions, fs, …)
    if (msg.method && msg.id != null) {
      this.emit("request", msg);
      return;
    }

    // Notification (session/update, …)
    if (msg.method) {
      this.emit("notification", msg);
      return;
    }

    this.emit("message", msg);
  }

  #rejectAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * @returns {string}
 */
export function newClientSessionId() {
  return randomUUID();
}
