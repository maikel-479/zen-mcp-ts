import { connect, type Socket } from "node:net";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BiDiResponse,
  BrowsingContext,
  GetTreeResult,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
} from "./types.js";

const DAEMON_PORT = parseInt(process.env.ZEN_MCP_DAEMON_PORT || "9223");
const LOCKFILE = path.join(os.tmpdir(), "zen-mcp-daemon.pid");

function log(...args: unknown[]) {
  console.error("[zen-mcp]", ...args);
}

// ─── Daemon Protocol ──────────────────────────────────────────────

interface DaemonRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface DaemonResponse {
  id: number;
  result?: unknown;
  error?: { message: string; code: number };
}

// ─── Daemon Client (BiDiClient-compatible) ────────────────────────

export class DaemonClient {
  private socket: Socket | null = null;
  private msgId = 0;
  private pending = new Map<
    number,
    {
      resolve: (r: DaemonResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = "";
  private _sessionId: string | null = null;
  private _webSocketUrl: string | null = null;
  private _currentContext: string | null = null;
  private _agentContext: string | null = null;

  get sessionId(): string | null {
    return this._sessionId;
  }

  get currentContext(): string | null {
    return this._currentContext;
  }

  set currentContext(ctx: string | null) {
    this._currentContext = ctx;
  }

  get agentContext(): string | null {
    return this._agentContext;
  }

  async ensureDaemon(): Promise<void> {
    if (await this._isDaemonRunning()) return;
    await this._startDaemon();
    await this._waitForDaemon();
  }

  async connect(): Promise<void> {
    if (this.socket) return;

    await this.ensureDaemon();

    return new Promise((resolve, reject) => {
      const socket = connect(DAEMON_PORT, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Daemon connection timeout"));
      }, 5000);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this._setupListeners(socket);

        // Request session
        this._send({ id: ++this.msgId, method: "connect" })
          .then(async (resp) => {
            if (resp.error) {
              reject(new Error(resp.error.message));
              return;
            }
            const result = resp.result as { sessionId: string; webSocketUrl: string };
            this._sessionId = result.sessionId;
            this._webSocketUrl = result.webSocketUrl;
            log("Connected to daemon, session:", result.sessionId);

            // Create agent tab
            await this._ensureAgentTab();
            resolve();
          })
          .catch(reject);
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Cannot connect to daemon on port ${DAEMON_PORT}: ${err.message}`));
      });
    });
  }

  private async _ensureAgentTab(): Promise<void> {
    if (this._agentContext) return;
    const resp = await this.sendBidi("browsingContext.create", { type: "tab" });
    const result = resp.result as unknown as { context: string };
    this._agentContext = result.context;
    this._currentContext = this._agentContext;
    log("Agent tab:", this._agentContext);
  }

  async sendBidi(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30000,
  ): Promise<BiDiResponse> {
    const resp = await this._send(
      { id: ++this.msgId, method: "bidi", params: { method, params } },
      timeout,
    );
    if (resp.error) {
      throw new Error(resp.error.message);
    }
    return resp.result as BiDiResponse;
  }

  async disconnect(): Promise<void> {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
      this.socket = null;
    }
    this._sessionId = null;
    this._webSocketUrl = null;
  }

  async endSession(): Promise<void> {
    if (this.socket) {
      try {
        await this._send({ id: ++this.msgId, method: "end-session" });
      } catch {}
    }
    await this.disconnect();
  }

  async getStatus(): Promise<{ active: boolean; sessionId: string | null; clients: number }> {
    await this.ensureDaemon();
    await this._ensureConnected();
    const resp = await this._send({ id: ++this.msgId, method: "status" });
    return resp.result as { active: boolean; sessionId: string | null; clients: number };
  }

  private async _ensureConnected(): Promise<void> {
    if (this.socket) return;
    return new Promise((resolve, reject) => {
      const socket = connect(DAEMON_PORT, "127.0.0.1");
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Daemon connection timeout"));
      }, 5000);

      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this._setupListeners(socket);
        resolve();
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Cannot connect to daemon: ${err.message}`));
      });
    });
  }

  get webSocketUrl(): string | null {
    return this._webSocketUrl;
  }

  // ─── BiDiClient-compatible methods ─────────────────────────────

  async getContexts(): Promise<BrowsingContext[]> {
    const resp = await this.sendBidi("browsingContext.getTree", {});
    return (resp.result as unknown as GetTreeResult).contexts || [];
  }

  async getActiveContext(): Promise<string> {
    const contexts = await this.getContexts();
    if (contexts.length === 0) {
      throw new Error("No browsing contexts available. Open a tab in Zen first.");
    }
    return this._currentContext || contexts[0].context;
  }

  async getContextByIndex(index: number): Promise<string> {
    const contexts = await this.getContexts();
    if (index < 0 || index >= contexts.length) {
      throw new Error(`Invalid tab index ${index}. ${contexts.length} tabs available.`);
    }
    return contexts[index].context;
  }

  async navigate(url: string): Promise<NavigateResult> {
    const ctx = await this.getActiveContext();
    const resp = await this.sendBidi("browsingContext.navigate", {
      context: ctx,
      url,
      wait: "interactive",
    });
    return resp.result as unknown as NavigateResult;
  }

  async evaluate(expression: string, contextId?: string): Promise<EvaluateResult> {
    const ctx = contextId || (await this.getActiveContext());
    const resp = await this.sendBidi("script.evaluate", {
      expression,
      target: { context: ctx },
      awaitPromise: true,
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 10 },
    });
    return resp as unknown as EvaluateResult;
  }

  async callFunction(
    fn: string,
    args: Array<{ type: string; value: unknown }> = [],
    contextId?: string,
  ): Promise<BiDiResponse> {
    const ctx = contextId || (await this.getActiveContext());
    return this.sendBidi("script.callFunction", {
      functionDeclaration: fn,
      arguments: args,
      target: { context: ctx },
      awaitPromise: true,
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 10 },
    });
  }

  async screenshot(contextId?: string): Promise<ScreenshotResult> {
    const ctx = contextId || (await this.getActiveContext());
    const resp = await this.sendBidi("browsingContext.captureScreenshot", { context: ctx });
    return resp.result as unknown as ScreenshotResult;
  }

  async createTab(url = "about:blank"): Promise<string> {
    const resp = await this.sendBidi("browsingContext.create", { type: "tab" });
    const result = resp.result as unknown as { context: string };
    const ctx = result.context;
    if (url !== "about:blank") {
      await this.sendBidi("browsingContext.navigate", { context: ctx, url, wait: "interactive" });
    }
    return ctx;
  }

  async closeTab(contextId: string): Promise<void> {
    await this.sendBidi("browsingContext.close", { context: contextId });
  }

  async performKeyActions(
    actions: Array<{ type: string; value: string }>,
    contextId?: string,
  ): Promise<void> {
    const ctx = contextId || (await this.getActiveContext());
    await this.sendBidi("input.performActions", {
      context: ctx,
      actions: [{ type: "key", id: "kb1", actions }],
    });
  }

  // ─── Internal ──────────────────────────────────────────────────

  private _send(msg: DaemonRequest, timeout = 30000): Promise<DaemonResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        return reject(new Error("Not connected to daemon"));
      }
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Daemon timeout after ${timeout}ms: ${msg.method}`));
      }, timeout);
      this.pending.set(msg.id, { resolve, reject, timer });
      this.socket.write(JSON.stringify(msg) + "\n");
    });
  }

  private _setupListeners(socket: Socket): void {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          const msg: DaemonResponse = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id)!;
            clearTimeout(timer);
            this.pending.delete(msg.id);
            if (msg.error) {
              reject(new Error(msg.error.message));
            } else {
              resolve(msg);
            }
          }
        }
      }
    });

    socket.on("close", () => {
      this.socket = null;
      for (const [, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new Error("Daemon connection closed"));
      }
      this.pending.clear();
    });

    socket.on("error", (err) => {
      log("Daemon socket error:", err.message);
    });
  }

  private async _isDaemonRunning(): Promise<boolean> {
    if (!existsSync(LOCKFILE)) return false;
    try {
      const pid = parseInt(await readFile(LOCKFILE, "utf8"));
      process.kill(pid, 0);
      return true;
    } catch {
      await unlink(LOCKFILE).catch(() => {});
      return false;
    }
  }

  private async _startDaemon(): Promise<void> {
    log("Starting daemon...");
    const __filename = fileURLToPath(import.meta.url);
    const daemonPath = path.resolve(path.dirname(__filename), "daemon.js");

    const child = fork(daemonPath, [], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  private async _waitForDaemon(maxWait = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      if (existsSync(LOCKFILE)) {
        try {
          const pid = parseInt(await readFile(LOCKFILE, "utf8"));
          process.kill(pid, 0);
          // Daemon is running, try connecting
          return new Promise((resolve, reject) => {
            const socket = connect(DAEMON_PORT, "127.0.0.1");
            const timer = setTimeout(() => {
              socket.destroy();
              reject(new Error("Daemon connect timeout"));
            }, 2000);
            socket.once("connect", () => {
              clearTimeout(timer);
              socket.destroy();
              resolve();
            });
            socket.once("error", () => {
              clearTimeout(timer);
              // Retry
              resolve();
            });
          });
        } catch {
          // PID dead, retry
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("Daemon failed to start within timeout");
  }
}

// ─── Singleton ────────────────────────────────────────────────────

let _instance: DaemonClient | null = null;

export function getDaemonClient(): DaemonClient {
  if (!_instance) {
    _instance = new DaemonClient();
  }
  return _instance;
}
