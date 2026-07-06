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

/**
 * Try to end a zombie BiDi session by reconnecting to its webSocketUrl.
 * This only works if we saved the webSocketUrl from the original session.new response.
 */
async function endZombieSession(record: SessionRecord): Promise<boolean> {
  try {
    log(`Attempting to end zombie session ${record.sessionId} via ${record.webSocketUrl}`);
    const ws = new WebSocket(record.webSocketUrl);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Connection timeout"));
      }, 5000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    });

    // Send session.end
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("session.end timeout"));
      }, 5000);

      ws.once("message", (data) => {
        clearTimeout(timer);
        const msg = JSON.parse(data.toString());
        if (msg.error) {
          log("session.end error (non-fatal):", msg.error.message);
        } else {
          log("Zombie session ended successfully:", record.sessionId);
        }
        ws.close();
        resolve();
      });

      ws.send(JSON.stringify({ id: 1, method: "session.end", params: {} }));
    });

    return true;
  } catch (e) {
    log("Could not end zombie session (non-fatal):", e instanceof Error ? e.message : String(e));
    return false;
  }
}

export async function acquireSession(port: number): Promise<{
  ws: WebSocket;
  sessionId: string;
  reused: boolean;
}> {
  // Always try session.new first — then clean up any zombie if it fails.
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

    if (
      msg.includes("Maximum number of active sessions") ||
      msg.includes("session not created")
    ) {
      // A zombie exists. Try to end it using the saved webSocketUrl.
      const prior = await loadRecord();
      if (prior) {
        const cleared = await endZombieSession(prior);
        if (cleared) {
          // Zombie cleared — try session.new again
          try {
            const { ws, sessionId, webSocketUrl } = await createFreshSession(port);
            await saveRecord({
              sessionId,
              webSocketUrl,
              pid: process.pid,
              createdAt: Date.now(),
            });
            log("Session created after clearing zombie");
            return { ws, sessionId, reused: false };
          } catch (retryErr) {
            // Still failing — fall through to error
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            log("Session creation still failed after clearing zombie:", retryMsg);
          }
        } else {
          // Could not connect to old session — it's probably already dead
          // (Zen restarted, session is gone). Clear stale record and retry.
          log("Old session unreachable — clearing stale record and retrying");
          await deleteRecord();
          try {
            const { ws, sessionId, webSocketUrl } = await createFreshSession(port);
            await saveRecord({
              sessionId,
              webSocketUrl,
              pid: process.pid,
              createdAt: Date.now(),
            });
            log("Session created after clearing stale record");
            return { ws, sessionId, reused: false };
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            log("Session creation still failed:", retryMsg);
          }
        }

        // Could not clear zombie — provide clear error
        const isAlive = isProcessAlive(prior.pid);
        if (!isAlive) {
          log(
            `Zombie session ${prior.sessionId} from dead process ${prior.pid} could not be cleared.\n` +
              `Restart Zen Browser to clear it.`,
          );
        } else {
          log(
            `Session ${prior.sessionId} is owned by active process ${prior.pid}.\n` +
              `Close that process first.`,
          );
        }
      } else {
        log(
          "Foreign BiDi session is attached to Zen.\n" +
            "Close the other client or restart Zen.",
        );
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
          msg.result.capabilities?.webSocketUrl ||
          `ws://127.0.0.1:${port}/session/${sessionId}`;
        log("New session created:", sessionId);
        resolve({ ws, sessionId, webSocketUrl: wsUrl });
      };

      ws.on("message", onMessage);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
