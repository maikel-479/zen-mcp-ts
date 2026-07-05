# Bug: Zombie BiDi session blocks new connections

## Summary

When the MCP server process exits without cleanly ending its BiDi session (e.g. killed by timeout, SIGKILL, or crash), the orphaned session stays alive in Zen Browser. Any subsequent server instance fails to create a new session because Zen only allows 1 active BiDi session at a time.

## Key insight

From zen-mcp docs: **"Zombie sessions can only be cleared by restarting Zen (BiDi session.end is connection-scoped)."**

This means `session.end` only works on the WebSocket connection that created the session. A new connection cannot end an old session.

## Reproduction

1. Start Zen Browser with `--remote-debugging-port 9222`
2. Run `node dist/index.js` and send a tool call (e.g. `zen_list_pages`)
3. Kill the process before it can clean up (timeout, SIGKILL, etc.)
4. Run `node dist/index.js` again — fails with zombie session error

## Fix applied

In `src/bidi-client.ts`, broadened zombie detection to also handle `"session not created"` (not just `"Maximum number of active sessions"`), and removed the broken `_endZombieSession` recovery that tried to use `session.end` from a new connection.

Instead, the error message now clearly tells the user to restart Zen Browser:

```
Zen Browser has a zombie BiDi session from a previous client.
session.end is connection-scoped and cannot clear it remotely.

Fix: Restart Zen Browser:
  "C:\Program Files\Zen Browser\zen.exe" --remote-debugging-port 9222
```

## Environment

- Zen Browser 1.21.5b (Windows)
- zen-mcp-ts 1.0.0
- Node.js
