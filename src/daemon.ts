#!/usr/bin/env node

import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import WebSocket from "ws";
import type { BiDiResponse } from "./types.js";

const DAEMON_PORT = parseInt(process.env.ZEN_MCP_DAEMON_PORT || "9223");
const ZEN_PORT = parseInt(process.env.ZEN_DEBUG_PORT || "9222");
const LOCKFILE = path.join(os.tmpdir(), "zen-mcp-daemon.pid");
const SESSION_FILE = path.join(os.tmpdir(), "zen-mcp-session.json");
const MAX_RECONNECT = 5;
const RECONNECT_DELAY = 1000;

function log(...args: unknown[]) {
  console.error("[zen-daemon]", ...args);
}

interface SessionRecord {
  sessionId: string;
  webSocketUrl: string;
  pid: number;
  createdAt: number;
}

// ─── Session Store ────────────────────────────────────────────────

async function loadRecord(): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function saveRecord(record: SessionRecord): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(record));
}

async function deleteRecord(): Promise<void> {
  await unlink(SESSION_FILE).catch(() => {});
}

// ─── Daemon BiDi Client ──────────────────────────────────────────

class DaemonBiDiClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private webSocketUrl: string | null = null;
  private msgId = 0;
  private pending = new Map<
    number,
    {
      resolve: (r: BiDiResponse) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private _intentionalDisconnect = false;
  private _reconnecting = false;

  get sessionActive(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionId !== null;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get activeWebSocketUrl(): string | null {
    return this.webSocketUrl;
  }

  async createSession(): Promise<{ sessionId: string; webSocketUrl: string }> {
    if (this.sessionActive && this.sessionId && this.webSocketUrl) {
      return { sessionId: this.sessionId, webSocketUrl: this.webSocketUrl };
    }

    const { ws, sessionId, webSocketUrl } = await this._createFreshSession();
    this.ws = ws;
    this.sessionId = sessionId;
    this.webSocketUrl = webSocketUrl;
    this._setupListeners(ws);

    await saveRecord({
      sessionId,
      webSocketUrl,
      pid: process.pid,
      createdAt: Date.now(),
    });

    log("Session created:", sessionId);
    return { sessionId, webSocketUrl };
  }

  async endSession(): Promise<void> {
    this._intentionalDisconnect = true;
    if (this.ws?.readyState === WebSocket.OPEN && this.sessionId) {
      try {
        await this.send("session.end", {}, 3000);
        log("Session ended cleanly");
      } catch (e) {
        log("Session end error (non-fatal):", e);
      }
    }
    this.sessionId = null;
    this.webSocketUrl = null;
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
    await deleteRecord();
  }

  async reconnect(): Promise<void> {
    if (!this.webSocketUrl) {
      throw new Error("No session to reconnect to");
    }
    log("Reconnecting to existing session via", this.webSocketUrl);
    const ws = new WebSocket(this.webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Reconnect timeout"));
      }, 5000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    this.ws = ws;
    this._intentionalDisconnect = false;
    this._setupListeners(ws);
    log("Reconnected to session:", this.sessionId);
  }

  async send(
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

  private _setupListeners(ws: WebSocket): void {
    ws.removeAllListeners();

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

    ws.on("close", (code) => {
      log(`WebSocket closed (code: ${code})`);
      this.ws = null;
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
    if (this._reconnecting || this._intentionalDisconnect || !this.webSocketUrl) return;
    if (attempt > MAX_RECONNECT) {
      log(`Reconnect failed after ${MAX_RECONNECT} attempts`);
      return;
    }
    this._reconnecting = true;
    const delay = RECONNECT_DELAY * Math.pow(2, attempt - 1);
    log(`Reconnecting in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT})...`);
    setTimeout(async () => {
      if (this._intentionalDisconnect) {
        this._reconnecting = false;
        return;
      }
      try {
        await this.reconnect();
        log("Reconnected successfully");
      } catch {
        log(`Reconnect attempt ${attempt} failed`);
        this._scheduleReconnect(attempt + 1);
      }
      this._reconnecting = false;
    }, delay);
  }

  private _createFreshSession(
    port = ZEN_PORT,
  ): Promise<{ ws: WebSocket; sessionId: string; webSocketUrl: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);

      const onError = () => {
        ws.removeListener("open", onOpen);
        reject(
          new Error(
            `Cannot connect to Zen Browser at ws://127.0.0.1:${port}/session\n` +
              `Make sure Zen is running with:\n  zen --remote-debugging-port ${port}`,
          ),
        );
      };

      const onOpen = () => {
        ws.removeListener("error", onError);
        ws.send(
          JSON.stringify({
            id: 1,
            method: "session.new",
            params: { capabilities: { webSocketUrl: true } },
          }),
        );

        const onMessage = (data: WebSocket.RawData) => {
          const msg = JSON.parse(data.toString());
          if (msg.id !== 1) return;
          ws.removeListener("message", onMessage);

          if (msg.type === "error" || msg.error) {
            const errMsg = msg.error?.message || JSON.stringify(msg.error);
            ws.close();
            reject(new Error(errMsg));
            return;
          }

          const sessionId = msg.result.sessionId;
          const wsUrl =
            msg.result.capabilities?.webSocketUrl || `ws://127.0.0.1:${port}/session/${sessionId}`;
          resolve({ ws, sessionId, webSocketUrl: wsUrl });
        };

        ws.on("message", onMessage);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }
}

// ─── Daemon TCP Server ────────────────────────────────────────────

class DaemonServer {
  private server: Server;
  private bidi: DaemonBiDiClient;
  private clients = new Map<Socket, string>();
  private _started = false;

  constructor() {
    this.bidi = new DaemonBiDiClient();
    this.server = createServer((socket) => this._onConnection(socket));
  }

  async start(): Promise<void> {
    if (this._started) return;

    // Write PID file
    await writeFile(LOCKFILE, String(process.pid));

    // Try to restore existing session
    const prior = await loadRecord();
    if (prior) {
      log("Found prior session record:", prior.sessionId);
      try {
        await this.bidi.createSession();
        log("Session restored:", this.bidi.activeSessionId);
      } catch {
        log("Could not restore prior session, creating new one");
        await this.bidi.createSession();
      }
    } else {
      await this.bidi.createSession();
    }

    // Start TCP server
    await new Promise<void>((resolve) => {
      this.server.listen(DAEMON_PORT, "127.0.0.1", () => {
        log(`Listening on 127.0.0.1:${DAEMON_PORT}`);
        this._started = true;
        resolve();
      });
    });

    // Cleanup on exit
    const cleanup = async () => {
      log("Daemon shutting down...");
      for (const [socket] of this.clients) {
        socket.destroy();
      }
      await this.bidi.endSession();
      await unlink(LOCKFILE).catch(() => {});
      process.exit(0);
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);
    process.on("beforeExit", async () => {
      await this.bidi.endSession();
      await unlink(LOCKFILE).catch(() => {});
    });
  }

  private _onConnection(socket: Socket): void {
    const addr = `${socket.remoteAddress}:${socket.remotePort}`;
    log("Client connected:", addr);
    this.clients.set(socket, addr);

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          this._onMessage(socket, JSON.parse(line));
        }
      }
    });

    socket.on("close", () => {
      log("Client disconnected:", addr);
      this.clients.delete(socket);
    });

    socket.on("error", (err) => {
      log("Client error:", err.message);
      this.clients.delete(socket);
    });
  }

  private _onMessage(
    socket: Socket,
    msg: { id: number; method: string; params?: Record<string, unknown> },
  ): void {
    const { id, method, params } = msg;

    switch (method) {
      case "connect":
        this._handleConnect(socket, id).catch((e) => {
          this._send(socket, { id, error: { message: e.message, code: -1 } });
        });
        break;

      case "bidi":
        this._handleBidi(socket, id, params || {}).catch((e) => {
          this._send(socket, { id, error: { message: e.message, code: -1 } });
        });
        break;

      case "end-session":
        this._handleEndSession(socket, id).catch((e) => {
          this._send(socket, { id, error: { message: e.message, code: -1 } });
        });
        break;

      case "status":
        this._send(socket, {
          id,
          result: {
            active: this.bidi.sessionActive,
            sessionId: this.bidi.activeSessionId,
            clients: this.clients.size,
          },
        });
        break;

      default:
        this._send(socket, { id, error: { message: `Unknown method: ${method}`, code: -1 } });
    }
  }

  private async _handleConnect(socket: Socket, id: number): Promise<void> {
    if (this.bidi.sessionActive) {
      // Session already exists — tell client the webSocketUrl
      this._send(socket, {
        id,
        result: {
          sessionId: this.bidi.activeSessionId,
          webSocketUrl: this.bidi.activeWebSocketUrl,
        },
      });
      return;
    }

    // Session died or first connect — try reconnect, then create if needed
    if (this.bidi.activeWebSocketUrl) {
      try {
        await this.bidi.reconnect();
        this._send(socket, {
          id,
          result: {
            sessionId: this.bidi.activeSessionId,
            webSocketUrl: this.bidi.activeWebSocketUrl,
          },
        });
        return;
      } catch {
        // Reconnect failed — fall through to create new
      }
    }

    const { sessionId, webSocketUrl } = await this.bidi.createSession();
    this._send(socket, { id, result: { sessionId, webSocketUrl } });
  }

  private async _handleBidi(
    socket: Socket,
    id: number,
    params: Record<string, unknown>,
  ): Promise<void> {
    const method = params.method as string;
    const bidiParams = (params.params as Record<string, unknown>) || {};
    const result = await this.bidi.send(method, bidiParams);
    this._send(socket, { id, result });
  }

  private async _handleEndSession(socket: Socket, id: number): Promise<void> {
    await this.bidi.endSession();
    this._send(socket, { id, result: { ended: true } });
  }

  private _send(socket: Socket, msg: unknown): void {
    if (socket.writable) {
      socket.write(JSON.stringify(msg) + "\n");
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  // Check if daemon is already running
  if (existsSync(LOCKFILE)) {
    try {
      const pid = parseInt(await readFile(LOCKFILE, "utf8"));
      process.kill(pid, 0);
      log(`Daemon already running (PID ${pid})`);
      process.exit(0);
    } catch {
      // Stale PID file
      await unlink(LOCKFILE).catch(() => {});
    }
  }

  const daemon = new DaemonServer();
  await daemon.start();
  log("Daemon ready");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
