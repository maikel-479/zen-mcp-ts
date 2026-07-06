# Zombie Vectors — Complete Audit

**Date:** 2026-07-06
**Status:** All vectors identified, some mitigated, some still active

## What is a "zombie" in this project?

A zombie is any resource that persists in Zen Browser after the MCP server process that created it has died. Two types:

1. **BiDi Session Zombie** — A `session.new` was called, the session is alive in Zen, but the process that created it is gone. Zen only allows one active session, so new `session.new` calls fail.
2. **Container Zombie** — A `browser.createUserContext` was called, creating a Container Tab in Zen that persists forever. _(Fixed: d2de3da)_

---

## Active Zombie Vectors

### ZOMBIE-1: Process killed without cleanup

**File:** Any process using `BiDiClient`
**Trigger:** `SIGKILL`, `taskkill /F`, crash, unhandled exception, timeout
**What happens:** `session.end` never sent. BiDi session stays alive in Zen.
**Current mitigation:** `session-store.ts:acquireSession()` saves `webSocketUrl` to disk. On next startup, `endZombieSession()` reconnects to the saved URL and sends `session.end`.
**Remaining gap:** If session store file is deleted or `webSocketUrl` returns 404 (session already dead in Zen), zombie can't be cleared automatically. User must restart Zen.

### ZOMBIE-2: Each CLI invocation creates a new process

**File:** Any `node -e "..."` or `node script.js` that imports `BiDiClient`
**Trigger:** Running the MCP server as a one-shot command
**What happens:** Process starts → `createFreshSession()` → session created → process exits → session becomes zombie. Next invocation fails.
**Current mitigation:** Zombie cleanup in `session-store.ts` tries to end the old session before creating a new one.
**Remaining gap:** Race condition — if process is killed before `saveRecord()` completes, no `webSocketUrl` is saved. Zombie can't be cleaned up.

### ZOMBIE-3: Auto-reconnect after unexpected WebSocket close

**File:** `src/bidi-client.ts` (ws.on('close') handler)
**Trigger:** Network interruption, Zen restart, WebSocket timeout
**What happens:** WebSocket closes → `_scheduleReconnect()` → `connect()` → `acquireSession()` → `session.new`. If old session is still alive (zombie), `session.new` fails.
**Current mitigation:** `session-store.ts` zombie cleanup handles this case.
**Remaining gap:** Each failed reconnect attempt still creates a new WebSocket connection to Zen, adding noise.

### ZOMBIE-4: `zen_reconnect` tool

**File:** `src/tools/utility.ts`
**Trigger:** User/AI calls `zen_reconnect`
**What happens:** `disconnect()` → `connect()`. If `disconnect()` fails to send `session.end` (WebSocket already closed, timeout), old session becomes zombie.
**Current mitigation:** `disconnect()` has try/catch around `session.end`.
**Remaining gap:** If `session.end` times out (3s), the session might still be alive. No retry.

### ZOMBIE-5: `endSession()` called from `beforeExit`

**File:** `src/index.ts`, `src/bidi-client.ts`
**Trigger:** Node.js `beforeExit` event
**What happens:** `endSession()` tries `session.end`. If WebSocket is already closed or process is exiting too fast, the async `session.end` might not complete.
**Current mitigation:** `beforeExit` fires on normal exit when event loop drains.
**Remaining gap:** `beforeExit` doesn't fire on `SIGKILL` or `SIGTERM` (those have their own handlers). If both `beforeExit` and `SIGTERM` handler run, `endSession()` might be called after `disconnect()` already ended the session — second call fails silently.

### ZOMBIE-6: Test harness `proc.kill()`

**File:** `tests/test-all-features.cjs`
**Trigger:** End of test run
**What happens:** `proc.kill()` sends SIGTERM. Server's `gracefulShutdown` handler calls `disconnect()`. But `proc.kill()` doesn't wait for cleanup — if the process exits before `disconnect()` completes, session becomes zombie.
**Current mitigation:** `gracefulShutdown` handler catches SIGTERM and calls `disconnect()`.
**Remaining gap:** `proc.kill()` is fire-and-forget. No grace period for async cleanup.

### ZOMBIE-7: Multiple simultaneous server instances

**File:** Any scenario where multiple `node dist/index.js` run at once
**Trigger:** User starts multiple servers, or rapid restart
**What happens:** First server creates session. Second server tries `session.new` → fails with "Maximum number of active sessions".
**Current mitigation:** `session-store.ts` detects zombie and tries cleanup.
**Remaining gap:** If both processes are alive, neither can end the other's session (only the creator can via `webSocketUrl`).

### ZOMBIE-11: `disconnect()` not re-entrant safe _(Fixed: 2026-07-06)_

**File:** `src/bidi-client.ts:disconnect()`
**Trigger:** Two callers invoke `disconnect()` concurrently (e.g., `transport.onclose` + `SIGTERM` handler + `endSession()` + `zen_reconnect`)
**What happened:** Second caller enters `_doDisconnect()` while first is still awaiting `session.end`. Both race on `this.ws.terminate()`.
**Fix:** Shared-promise pattern — `_doDisconnect()` stores its promise in `_disconnectPromise`. Second caller awaits the same promise instead of entering a second copy.

### ZOMBIE-12: Reconnect timer not cancelled on intentional disconnect _(Fixed: 2026-07-06)_

**File:** `src/bidi-client.ts:_scheduleReconnect()`
**Trigger:** `disconnect()` or `endSession()` called while reconnect timer is pending
**What happened:** Timer fires after disconnect → `connect()` → new session → zombie.
**Fix:** Timer handle stored in `_reconnectTimer`. Cleared in `disconnect()` and `endSession()`. Callback also re-checks `_intentionalDisconnect` after setTimeout delay.

### ZOMBIE-13: `endSession()` didn't set `_intentionalDisconnect` _(Fixed: 2026-07-06)_

**File:** `src/bidi-client.ts:endSession()`
**Trigger:** `endSession()` called directly (e.g., from `beforeExit`)
**What happened:** `session.end` sent, but `ws` not terminated. If `onclose` fires from the `session.end` response, reconnect logic triggers because `_intentionalDisconnect` was still `false`.
**Fix:** `endSession()` now sets `_intentionalDisconnect = true`, clears reconnect timer, and terminates WebSocket.

### ZOMBIE-14: MCP server keeps process alive after disconnect _(Fixed: 2026-07-06)_

**File:** `src/index.ts:transport.onclose`
**Trigger:** MCP client closes stdio stream while server is still running
**What happened:** `bidi.disconnect()` called but no `process.exit(0)`. Node event loop stays alive (from per-request `setTimeout` timers in `BiDiClient.send()`). Process hangs until SIGKILL.
**Fix:** Added `process.exit(0)` after `bidi.disconnect()` in `transport.onclose`.

---

## Fixed Zombie Vectors

### ZOMBIE-10: Container Tab pileup _(Fixed: d2de3da)_

**File:** `src/bidi-client.ts` (old `_ensureAgentTab`)
**Trigger:** Every `session.new` via `acquireSession()`
**What happened:** `_ensureAgentTab()` called `browser.createUserContext` on every session start, creating a new Container Tab in Zen. Never cleaned up.
**Fix:** Removed `browser.createUserContext` entirely. Agent tab now lives in default context. Isolation works via separate tabs, not containers.

---

## Mitigation Summary

| Vector    | Status    | Mitigation                                                                    |
| --------- | --------- | ----------------------------------------------------------------------------- |
| ZOMBIE-1  | Partial   | `session-store.ts` saves `webSocketUrl`, auto-cleanup on next start           |
| ZOMBIE-2  | Partial   | Same as above — depends on `webSocketUrl` being saved                         |
| ZOMBIE-3  | Partial   | Same as above                                                                 |
| ZOMBIE-4  | Partial   | `disconnect()` has try/catch, but no retry on timeout                         |
| ZOMBIE-5  | Partial   | Six-layer cleanup in `index.ts`, but no re-entry protection in `endSession()` |
| ZOMBIE-6  | Partial   | SIGTERM handler exists, but `proc.kill()` doesn't wait                        |
| ZOMBIE-7  | Partial   | Error message tells user to restart Zen                                       |
| ZOMBIE-10 | **Fixed** | Container creation removed entirely                                           |
| ZOMBIE-11 | **Fixed** | Shared-promise pattern in `disconnect()`                                      |
| ZOMBIE-12 | **Fixed** | Reconnect timer cleared on intentional disconnect                             |
| ZOMBIE-13 | **Fixed** | `endSession()` sets `_intentionalDisconnect`, terminates ws                   |
| ZOMBIE-14 | **Fixed** | `process.exit(0)` after disconnect in `transport.onclose`                     |

---

## The Root Problem

All zombie vectors share one root cause: **BiDi sessions are connection-scoped but persist in the browser after the connection dies.** There is no way to end a session from a new connection unless you have the original `webSocketUrl`. This is a Gecko/Firefox limitation, not a bug in zen-mcp-ts.

The only 100% reliable fix is architectural: **keep a single long-lived server process that owns the session**, and have CLI invocations connect to it (e.g., via HTTP or named pipe) instead of each creating their own BiDi session.

---

## Files Involved

- `src/session-store.ts` — Session persistence, zombie detection, `endZombieSession()`
- `src/bidi-client.ts` — `acquireSession()`, `createFreshSession()`, `disconnect()`, `endSession()`, `_scheduleReconnect()`
- `src/index.ts` — Six-layer cleanup handlers (SIGINT, SIGTERM, beforeExit, etc.)
- `src/tools/utility.ts` — `zen_reconnect` tool
- `tests/test-all-features.cjs` — Test harness (creates zombies on exit)
