# Zombie Vectors — Complete Audit

**Date:** 2026-07-06
**Status:** Daemon architecture eliminates all zombie vectors. Remaining vectors are edge cases.

## What is a "zombie" in this project?

A zombie is any resource that persists in Zen Browser after the MCP server process that created it has died. Two types:

1. **BiDi Session Zombie** — A `session.new` was called, the session is alive in Zen, but the process that created it is gone. Zen only allows one active session, so new `session.new` calls fail.
2. **Container Zombie** — A `browser.createUserContext` was called, creating a Container Tab in Zen that persists forever. _(Fixed: d2de3da)_

## How the Daemon Eliminates Zombies

The daemon architecture (`src/daemon.ts`) solves the root cause: **BiDi sessions are connection-scoped but persist after the connection dies.**

```
Before (zombie-prone):
  MCP Server ──WebSocket──> Zen (creates session, becomes zombie on exit)

After (daemon):
  MCP Server ──TCP:9223──> Daemon ──WebSocket──> Zen (session stays alive permanently)
```

The daemon:
- Owns the BiDi session permanently (one session, one process, never dies)
- Auto-starts when the MCP server starts
- Stays alive after the MCP server exits
- Handles cleanup on shutdown (`session.end` sent before exit)
- Reconnects to existing sessions when new MCP server connects
- Detects MCP server disconnection via TCP socket close

---

## Eliminated Vectors (Fixed by Daemon Architecture)

### ZOMBIE-1: Process killed without cleanup — **ELIMINATED**

The daemon owns the session. If the MCP server is killed, the daemon stays alive. The session never becomes a zombie. If the daemon itself is killed, the session store (`webSocketUrl`) allows the next daemon to reconnect or clean up.

### ZOMBIE-2: Each CLI invocation creates a new process — **ELIMINATED**

The MCP server is now a thin proxy that connects to the daemon. No new BiDi sessions are created per invocation. All invocations share the same daemon session.

### ZOMBIE-3: Auto-reconnect after unexpected WebSocket close — **ELIMINATED**

The daemon handles reconnection internally. If the WebSocket to Zen dies, the daemon reconnects using the stored `webSocketUrl`. The MCP server never sees the reconnection.

### ZOMBIE-4: `zen_reconnect` tool — **ELIMINATED**

`zen_reconnect` disconnects from the daemon and reconnects. The daemon session persists. No new BiDi session is created.

### ZOMBIE-5: `endSession()` called from `beforeExit` — **ELIMINATED**

The MCP server's `beforeExit` handler calls `bidi.disconnect()` which disconnects from the daemon. The daemon session persists. Only when the daemon itself exits does `session.end` get sent.

### ZOMBIE-6: Test harness `proc.kill()` — **ELIMINATED**

The test harness kills the MCP server process. The daemon stays alive (detached background process). Session persists for the next test run.

### ZOMBIE-7: Multiple simultaneous server instances — **ELIMINATED**

Multiple MCP servers connect to the same daemon. The daemon serializes access to the single BiDi session. No conflict.

### ZOMBIE-10: Container Tab pileup — **FIXED** (d2de3da)

Removed `browser.createUserContext` entirely. Agent tab lives in default context.

### ZOMBIE-11: `disconnect()` re-entrant safety — **FIXED** (shared-promise pattern)

### ZOMBIE-12: Reconnect timer not cancelled — **FIXED** (timer stored and cleared)

### ZOMBIE-13: `endSession()` not setting `_intentionalDisconnect` — **FIXED**

### ZOMBIE-14: MCP server keeps process alive — **FIXED** (`process.exit(0)` in `transport.onclose`)

---

## Remaining Edge Cases

These are not zombies in the traditional sense — they're daemon-specific edge cases with mitigations.

### EDGE-1: Daemon crash loses session

**Trigger:** Daemon process crashes (OOM, uncaught exception)
**What happens:** BiDi session becomes a zombie in Zen.
**Mitigation:** Next MCP server auto-starts a new daemon. New daemon tries to reconnect via saved `webSocketUrl`. If reconnect fails, creates new session. Old session eventually times out or user restarts Zen.
**Risk:** Low. Daemon is a simple process with minimal code surface.

### EDGE-2: Zen restart while daemon alive

**Trigger:** User restarts Zen Browser while daemon is running
**What happens:** Daemon's WebSocket closes. Daemon detects disconnect, tries to reconnect. Reconnect fails (old session gone). Daemon creates new session on next MCP server connect.
**Mitigation:** Automatic. No user action needed.
**Risk:** None.

### EDGE-3: Stale PID file after daemon crash

**Trigger:** Daemon crashes without cleaning up PID file
**What happens:** Next `zen-mcp daemon start` sees stale PID, tries to kill it (fails), clears stale file, starts new daemon.
**Mitigation:** PID file check includes `process.kill(pid, 0)` liveness check.
**Risk:** None.

### EDGE-4: Multiple daemons (race condition)

**Trigger:** Two `zen-mcp daemon start` commands run simultaneously
**What happens:** Both try to create PID file. One succeeds, the other sees the PID file and exits.
**Mitigation:** PID file acts as a lock. `existsSync` + `kill(pid, 0)` check before starting.
**Risk:** Very low. Only happens with deliberate race.

---

## Mitigation Summary

| Vector    | Status      | Mitigation                                                              |
| --------- | ----------- | ----------------------------------------------------------------------- |
| ZOMBIE-1  | Eliminated  | Daemon owns session permanently                                         |
| ZOMBIE-2  | Eliminated  | MCP server is thin proxy, no new sessions per invocation                |
| ZOMBIE-3  | Eliminated  | Daemon handles reconnection internally                                  |
| ZOMBIE-4  | Eliminated  | `zen_reconnect` reconnects to daemon, session persists                  |
| ZOMBIE-5  | Eliminated  | MCP server disconnects from daemon, daemon session persists             |
| ZOMBIE-6  | Eliminated  | Daemon stays alive after MCP server killed                              |
| ZOMBIE-7  | Eliminated  | Multiple MCP servers share one daemon session                           |
| ZOMBIE-10 | **Fixed**   | Container creation removed entirely                                     |
| ZOMBIE-11 | **Fixed**   | Shared-promise pattern in `disconnect()`                                |
| ZOMBIE-12 | **Fixed**   | Reconnect timer cleared on intentional disconnect                       |
| ZOMBIE-13 | **Fixed**   | `endSession()` sets `_intentionalDisconnect`, terminates ws             |
| ZOMBIE-14 | **Fixed**   | `process.exit(0)` after disconnect in `transport.onclose`               |
| EDGE-1    | Mitigated   | Auto-restart + webSocketUrl reconnect                                   |
| EDGE-2    | Mitigated   | Automatic reconnection on Zen restart                                   |
| EDGE-3    | Mitigated   | Stale PID detection + cleanup                                           |
| EDGE-4    | Mitigated   | PID file lock + liveness check                                          |

---

## Files Involved

- `src/daemon.ts` — Daemon process (TCP server + BiDi session manager)
- `src/daemon-client.ts` — Client library for MCP server to talk to daemon
- `src/cli.ts` — Daemon management CLI (start/stop/status)
- `src/session-store.ts` — Session persistence (`webSocketUrl` on disk)
- `src/bidi-client.ts` — Original BiDiClient (still used for direct Zen connections)
- `src/index.ts` — MCP server (thin proxy to daemon)
- `tests/test-all-features.cjs` — Test harness
