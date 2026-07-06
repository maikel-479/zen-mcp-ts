import WebSocket from "ws";
import { acquireSession, deleteRecord } from "./session-store.js";
import type {
  BiDiResponse,
  BrowsingContext,
  GetTreeResult,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
} from "./types.js";

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY = 1000;

function log(...args: unknown[]) {
  console.error("[zen-mcp]", ...args);
}

function getStartCommand(port: number): string {
  return `zen --remote-debugging-port ${port}`;
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

  private _agentContext: string | null = null;
  private _currentContext: string | null = null;
  private _intentionalDisconnect = false;
  private _reconnecting = false;
  private _connectPromise: Promise<void> | null = null;
  private _disconnectPromise: Promise<void> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private port: number) {}

  get currentContext(): string | null {
    return this._currentContext;
  }

  set currentContext(ctx: string | null) {
    this._currentContext = ctx;
  }

  get agentContext(): string | null {
    return this._agentContext;
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

    try {
      const { ws, sessionId } = await acquireSession(this.port);
      this.ws = ws;
      this.sessionId = sessionId;
      this._setupListeners(ws);

      await this._ensureAgentTab();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("Maximum number of active sessions") ||
        msg.includes("session not created")
      ) {
        throw new Error(
          `A foreign BiDi session is attached to Zen.\n` +
            `Close it or restart Zen:\n  ${getStartCommand(this.port)}`,
        );
      }
      throw e instanceof Error ? e : new Error(msg);
    }
  }

  private async _ensureAgentTab(): Promise<void> {
    if (this._agentContext) return;

    // Create agent tab (in default user context — no container needed)
    const resp = await this.send("browsingContext.create", { type: "tab" });
    const result = resp.result as unknown as { context: string };
    this._agentContext = result.context;
    this._currentContext = this._agentContext;
    log("Agent tab:", this._agentContext);
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

    ws.on("close", (code, _reason) => {
      log(`WebSocket closed (code: ${code})`);
      this.ws = null;
      this.sessionId = null;
      for (const [, { reject, timer }] of this.pending) {
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
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._intentionalDisconnect) {
        this._reconnecting = false;
        return;
      }
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

  async getContextByIndex(index: number): Promise<string> {
    const contexts = await this.getContexts();
    if (index < 0 || index >= contexts.length) {
      throw new Error(`Invalid tab index ${index}. ${contexts.length} tabs available.`);
    }
    return contexts[index].context;
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

  async evaluate(expression: string, contextId?: string): Promise<EvaluateResult> {
    const ctx = contextId || (await this.getActiveContext());
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
    contextId?: string,
  ): Promise<BiDiResponse> {
    const ctx = contextId || (await this.getActiveContext());
    return this.send("script.callFunction", {
      functionDeclaration: fn,
      arguments: args,
      target: { context: ctx },
      awaitPromise: true,
      serializationOptions: { maxDomDepth: 0, maxObjectDepth: 10 },
    });
  }

  async screenshot(contextId?: string): Promise<ScreenshotResult> {
    const ctx = contextId || (await this.getActiveContext());
    const resp = await this.send("browsingContext.captureScreenshot", { context: ctx });
    return resp.result as unknown as ScreenshotResult;
  }

  async createTab(url = "about:blank"): Promise<string> {
    await this.ensureConnected();
    const resp = await this.send("browsingContext.create", { type: "tab" });
    const result = resp.result as unknown as { context: string };
    const ctx = result.context;
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
    if (this._agentContext === contextId) {
      this._agentContext = null;
      await this._ensureAgentTab();
    }
  }

  async performKeyActions(
    actions: Array<{ type: string; value: string }>,
    contextId?: string,
  ): Promise<void> {
    const ctx = contextId || (await this.getActiveContext());
    await this.send("input.performActions", {
      context: ctx,
      actions: [{ type: "key", id: "kb1", actions }],
    });
  }

  async endSession(): Promise<void> {
    this._intentionalDisconnect = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      try {
        await this.send("session.end", {}, 3000);
        log("Session ended cleanly");
        await deleteRecord();
      } catch (e) {
        log("Session end error (non-fatal):", e);
      }
    }
    this.sessionId = null;
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this._disconnectPromise) return this._disconnectPromise;
    this._disconnectPromise = this._doDisconnect();
    try {
      await this._disconnectPromise;
    } finally {
      this._disconnectPromise = null;
    }
  }

  private async _doDisconnect(): Promise<void> {
    this._intentionalDisconnect = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
        await this.send("session.end", {}, 3000);
        log("Session ended cleanly");
        await deleteRecord();
      }
    } catch (e) {
      log("Disconnect error (non-fatal):", e);
    } finally {
      this.sessionId = null;
      if (this.ws) {
        try {
          this.ws.terminate();
        } catch {}
        this.ws = null;
      }
    }
  }

  resetIntentionalDisconnect(): void {
    this._intentionalDisconnect = false;
  }
}
