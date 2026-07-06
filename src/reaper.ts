import { readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const LOCKFILE = path.join(os.tmpdir(), "zen-mcp-session.json");
const STALE_THRESHOLD_MS = 5 * 60_000;

interface SessionRecord {
  sessionId: string;
  webSocketUrl: string;
  pid: number;
  createdAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function log(...args: unknown[]) {
  console.error("[reaper]", ...args);
}

async function main() {
  let record: SessionRecord;
  try {
    record = JSON.parse(await readFile(LOCKFILE, "utf8"));
  } catch {
    log("No lockfile found. Nothing to reap.");
    return;
  }

  if (isProcessAlive(record.pid)) {
    log("Process " + record.pid + " is still alive. No reaping needed.");
    return;
  }

  const age = Date.now() - record.createdAt;
  if (age < STALE_THRESHOLD_MS) {
    log(
      "Process " +
        record.pid +
        " is dead but lockfile is only " +
        Math.round(age / 1000) +
        "s old. Waiting.",
    );
    return;
  }

  log(
    "Reaping zombie session " +
      record.sessionId +
      " (pid " +
      record.pid +
      " dead, age " +
      Math.round(age / 1000) +
      "s)",
  );

  try {
    const ws = new WebSocket(record.webSocketUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("Connection timeout"));
      }, 3000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    await new Promise<void>((resolve) => {
      ws.send(JSON.stringify({ id: 1, method: "session.end", params: {} }));
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 3000);
      ws.once("message", () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.once("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    log("Session ended successfully.");
  } catch (e) {
    log("Failed to connect/send session.end:", e);
  }

  await unlink(LOCKFILE).catch(() => {});
  log("Lockfile deleted.");
}

main();
