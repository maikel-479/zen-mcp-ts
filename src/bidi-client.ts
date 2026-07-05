import os from "node:os";
import WebSocket from "ws";
import type {
  BiDiResponse,
  BrowsingContext,
  GetTreeResult,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  SessionNewResult,
} from "./types.js";

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY = 1000;

function log(...args: unknown[]) {
  console.error("[zen-mcp]", ...args);
}

function getZenBinaryPath(): string {
  switch (os.platform()) {
    case "darwin":
      return "/Applications/Zen.app/Contents/MacOS/zen";
    case "win32":
      return "C:\\Program Files\\Zen Browser\\zen.exe";
    case "linux":
      return "zen";
    default:
      return "zen";
  }
}

function getStartCommand(port: number): string {
  const bin = getZenBinaryPath();
  if (os.platform() === "win32") {
    return `"${bin}" --remote-debugging-port ${port}`;
  }
  return `${bin} --remote-debugging-port ${port}`;
}

export class BiDiClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private msgId = 0;
  private pending = new Map<
    number,
    {
      resolve: (r: BiDiResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _currentContext: string | null = null;
  private _intentionalDisconnect = false;
  private _reconnecting = false;
  private _connectPromise: Promise<void> | null = null;

  constructor(private port: number) {}

  get currentContext(): string | null {
    return this._currentContext;
  }

  set currentContext(ctx: string | null) {
    this._currentContext = ctx;
  }

  private get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}/session`;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  private async _doConnect(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);

      const onError = (e: Error) => {
        ws.removeListener("open", onOpen);
        reject(
          new Error(
            `Cannot connect to Zen Browser at ${this.wsUrl}\n` +
              `Make sure Zen is running with:\n  ${getStartCommand(this.port)}`,
          ),
        );
      };

      const onOpen = async () => {
        ws.removeListener("error", onError);
        log("WebSocket connected");
        this.ws = ws;
        this._setupListeners(ws);
        try {
          await this._createSession();
          resolve();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (
            msg.includes("Maximum number of active sessions") ||
            msg.includes("session not created")
          ) {
            log("Zombie session detected — attempting to reuse existing session");
            try {
              await this._reuseSession();
              resolve();
            } catch {
              reject(
                new Error(
                  `Zen Browser has a zombie BiDi session that cannot be reused.\n` +
                    `Restart Zen Browser:\n  ${getStartCommand(this.port)}`,
                ),
              );
            }
          } else {
            reject(e instanceof Error ? e : new Error(msg));
          }
        }
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  private async _createSession(): Promise<void> {
    const resp = await this.send("session.new", { capabilities: {} });
    const sessionResult = resp.result as unknown as SessionNewResult;
    this.sessionId = sessionResult.sessionId;
    log("Session created:", this.sessionId);

    const treeResp = await this.send("browsingContext.getTree", {});
    const treeResult = treeResp.result as unknown as GetTreeResult;
    if (treeResult.contexts && treeResult.contexts.length > 0) {
      this._currentContext = treeResult.contexts[0].context;
      log("Active context:", this._currentContext);
    }
  }

  private async _reuseSession(): Promise<void> {
    log("Trying to reuse existing session via browsingContext.getTree...");
    const treeResp = await this.send("browsingContext.getTree", {});
    const treeResult = treeResp.result as unknown as GetTreeResult;
    if (treeResult.contexts && treeResult.contexts.length > 0) {
      this._currentContext = treeResult.contexts[0].context;
      log("Reused active context:", this._currentContext);
    } else {
      throw new Error("No active browsing contexts found to reuse");
    }
  }

  private _setupListeners(ws: WebSocket): void {
    ws.removeAllListeners("message");
    ws.removeAllListeners("close");

    ws.on("message", (data) => {
      try {
        const msg: BiDiResponse = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id)!;
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.type === "error" || msg.error) {
            reject(new Error(msg.error?.message || JSON.stringify(msg.error)));
          } else {
            resolve(msg);
          }
        }
      } catch {}
    });

    ws.on("close", (code, reason) => {
      log(`WebSocket closed (code: ${code})`);
      this.ws = null;
      this.sessionId = null;
      for (const [id, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new Error("Connection closed"));
      }
      this.pending.clear();
      if (!this._intentionalDisconnect) {
        this._scheduleReconnect();
      }
    });
  }

  private _scheduleReconnect(attempt = 1): void {
    if (this._reconnecting || this._intentionalDisconnect) return;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      log(`Reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      return;
    }
    this._reconnecting = true;
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, attempt - 1);
    log(`Reconnecting in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(async () => {
      try {
        await this.connect();
        log("Reconnected successfully");
      } catch {
        log(`Reconnect attempt ${attempt} failed`);
      }
      this._reconnecting = false;
    }, delay);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 30000,
  ): Promise<BiDiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("Not connected to Zen Browser"));
      }
      const id = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout after ${timeout}ms: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) return;
    let lastErr: Error | null = null;
    for (let i = 1; i <= MAX_RECONNECT_ATTEMPTS; i++) {
      try {
        await this.connect();
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (i < MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_BASE_DELAY * Math.pow(2, i - 1);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw new Error(
      `Failed to connect after ${MAX_RECONNECT_ATTEMPTS} attempts: ${lastErr?.message}`,
    );
  }

  async getContexts(): Promise<BrowsingContext[]> {
    await this.ensureConnected();
    const resp = await this.send("browsingContext.getTree", {});
    return (resp.result as unknown as GetTreeResult).contexts || [];
  }

  async getActiveContext(): Promise<string> {
    await this.ensureConnected();
    if (!this._currentContext) {
      const contexts = await this.getContexts();
      if (contexts.length === 0)
        throw new Error("No browsing contexts available. Open a tab in Zen first.");
      this._currentContext = contexts[0].context;
    }
    return this._currentContext;
  }

  async navigate(url: string): Promise<NavigateResult> {
    const ctx = await this.getActiveContext();
    const resp = await this.send("browsingContext.navigate", {
      context: ctx,
      url,
      wait: "interactive",
    });
    return resp.result as unknown as NavigateResult;
  }

  async evaluate(expression: string): Promise<EvaluateResult> {
    const ctx = await this.getActiveContext();
    const resp = await this.send("script.evaluate", {
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
  ): Promise<BiDiResponse> {
    const ctx = await this.getActiveContext();
    return this.send("script.callFunction", {
      functionDeclaration: fn,
      arguments: args,
      target: { context: ctx },
      awaitPromise: true,
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 10 },
    });
  }

  async screenshot(): Promise<ScreenshotResult> {
    const ctx = await this.getActiveContext();
    const resp = await this.send("browsingContext.captureScreenshot", { context: ctx });
    return resp.result as unknown as ScreenshotResult;
  }

  async createTab(url = "about:blank"): Promise<string> {
    await this.ensureConnected();
    const resp = await this.send("browsingContext.create", { type: "tab" });
    const result = resp.result as unknown as { context: string };
    const ctx = result.context;
    this._currentContext = ctx;
    if (url !== "about:blank") {
      await this.send("browsingContext.navigate", { context: ctx, url, wait: "interactive" });
    }
    return ctx;
  }

  async closeTab(contextId: string): Promise<void> {
    await this.send("browsingContext.close", { context: contextId });
    if (this._currentContext === contextId) {
      const remaining = await this.getContexts();
      this._currentContext = remaining.length > 0 ? remaining[0].context : null;
    }
  }

  async performKeyActions(actions: Array<{ type: string; value: string }>): Promise<void> {
    const ctx = await this.getActiveContext();
    await this.send("input.performActions", {
      context: ctx,
      actions: [{ type: "key", id: "kb1", actions }],
    });
  }

  async endSession(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      try {
        await this.send("session.end", {}, 3000);
        log("Session ended cleanly");
      } catch (e) {
        log("Session end error (non-fatal):", e);
      }
      this.sessionId = null;
    }
  }

  async disconnect(): Promise<void> {
    this._intentionalDisconnect = true;
    await this.endSession();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
      this.sessionId = null;
    }
  }

  resetIntentionalDisconnect(): void {
    this._intentionalDisconnect = false;
  }
}
