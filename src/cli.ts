#!/usr/bin/env node

import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDaemonClient } from "./daemon-client.js";

const LOCKFILE = path.join(os.tmpdir(), "zen-mcp-daemon.pid");

async function isDaemonRunning(): Promise<{ running: boolean; pid?: number }> {
  if (!existsSync(LOCKFILE)) return { running: false };
  try {
    const pid = parseInt(await readFile(LOCKFILE, "utf8"));
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    await unlink(LOCKFILE).catch(() => {});
    return { running: false };
  }
}

async function startDaemon(): Promise<void> {
  const status = await isDaemonRunning();
  if (status.running) {
    console.log(`Daemon already running (PID ${status.pid})`);
    return;
  }

  console.log("Starting daemon...");
  const __filename = fileURLToPath(import.meta.url);
  const daemonPath = path.resolve(path.dirname(__filename), "daemon.js");

  const child = fork(daemonPath, [], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for daemon to be ready
  const start = Date.now();
  while (Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 200));
    const s = await isDaemonRunning();
    if (s.running) {
      console.log(`Daemon started (PID ${s.pid})`);
      return;
    }
  }

  console.error("Daemon failed to start within 10s");
  process.exit(1);
}

async function stopDaemon(): Promise<void> {
  const status = await isDaemonRunning();
  if (!status.running) {
    console.log("Daemon not running");
    return;
  }

  console.log(`Stopping daemon (PID ${status.pid})...`);
  try {
    process.kill(status.pid!, "SIGTERM");
  } catch {}

  // Wait for PID file to be removed
  const start = Date.now();
  while (Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 200));
    if (!existsSync(LOCKFILE)) {
      console.log("Daemon stopped");
      return;
    }
  }

  // Force kill
  try {
    process.kill(status.pid!, "SIGKILL");
  } catch {}
  await unlink(LOCKFILE).catch(() => {});
  console.log("Daemon force-stopped");
}

async function daemonStatus(): Promise<void> {
  const status = await isDaemonRunning();
  if (!status.running) {
    console.log("Daemon: not running");
    return;
  }

  console.log(`Daemon: running (PID ${status.pid})`);

  try {
    const client = getDaemonClient();
    const info = await client.getStatus();
    console.log(`  Session: ${info.active ? "active" : "inactive"}`);
    if (info.sessionId) console.log(`  Session ID: ${info.sessionId}`);
    console.log(`  Connected clients: ${info.clients}`);
  } catch {
    console.log("  (could not query daemon status)");
  }
}

// ─── Main ─────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "start":
    await startDaemon();
    break;
  case "stop":
    await stopDaemon();
    break;
  case "status":
    await daemonStatus();
    break;
  default:
    console.log("Usage: zen-mcp daemon <start|stop|status>");
    console.log("");
    console.log("Commands:");
    console.log("  start   Start the daemon in the background");
    console.log("  stop    Stop the daemon gracefully");
    console.log("  status  Check if the daemon is running");
    process.exit(1);
}
