import { readFile, writeFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

function log(...args: unknown[]) {
  console.error("[zen-mcp]", ...args);
}

const LOCKFILE = path.join(os.tmpdir(), "zen-mcp-session.json");

interface SessionRecord {
  sessionId: string;
  webSocketUrl: string;
  pid: number;
  createdAt: number;
}

export async function loadRecord(): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await readFile(LOCKFILE, "utf8"));
  } catch {
    return null;
  }
}

export async function saveRecord(record: SessionRecord): Promise<void> {
  await writeFile(LOCKFILE, JSON.stringify(record));
}

export async function deleteRecord(): Promise<void> {
  await unlink(LOCKFILE).catch(() => {});
}

export async function acquireSession(port: number): Promise<{
  ws: WebSocket;
  sessionId: string;
  reused: boolean;
}> {
  // Always try session.new first — Firefox/Zen doesn't support reattaching
  // to existing sessions via /session/<sessionId> (returns 404).
  // The zombie session problem can only be prevented, not recovered from.
  try {
    const { ws, sessionId, webSocketUrl } = await createFreshSession(port);
    await saveRecord({
      sessionId,
      webSocketUrl,
      pid: process.pid,
      createdAt: Date.now(),
    });
    return { ws, sessionId, reused: false };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg.includes("Maximum number of active sessions") || msg.includes("session not created")) {
      // A zombie exists. Check if it's ours or foreign.
      const prior = await loadRecord();
      if (prior) {
        // Check if the process that created it is still alive
        const isAlive = isProcessAlive(prior.pid);
        if (!isAlive) {
          log(
            "Zombie session " +
              prior.sessionId +
              " from dead process " +
              prior.pid +
              " is blocking. Restart Zen to clear it.",
          );
        } else {
          log(
            "Session " +
              prior.sessionId +
              " is owned by active process " +
              prior.pid +
              ". Close that process first.",
          );
        }
      } else {
        log("Foreign BiDi session is attached to Zen. " + "Close the other client or restart Zen.");
      }
    }

    throw e instanceof Error ? e : new Error(msg);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function createFreshSession(
  port: number,
): Promise<{ ws: WebSocket; sessionId: string; webSocketUrl: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);

    const onError = (_e: Error) => {
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
        log("New session created:", sessionId);
        resolve({ ws, sessionId, webSocketUrl: wsUrl });
      };

      ws.on("message", onMessage);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
