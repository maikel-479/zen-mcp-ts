# zen-mcp-ts

MCP server for Zen Browser automation via WebDriver BiDi over WebSocket.

## Commands

```bash
vp exec tsc          # Build (TypeScript → dist/)
vp check             # Format + lint + type check
vp check --fix       # Auto-fix formatting
node dist/index.js   # Run server (requires Zen with --remote-debugging-port 9222)
node tests/test-all-features.cjs  # Run full test suite (requires Zen running)
node dist/cli.js daemon start|stop|status  # Manage the daemon
```

`vp build` does NOT work — this is a Node.js CLI project, not a Vite web app. Always use `vp exec tsc`.

## Architecture

```
AI Client ──stdio/MCP──> zen-mcp (thin proxy) ──TCP:9223──> zen-mcp-daemon ──WebSocket/BiDi──> Zen Browser (port 9222)
```

The MCP server is a thin proxy that forwards all BiDi commands to a persistent daemon over TCP. The daemon owns the BiDi session permanently — it stays alive across MCP server restarts, eliminating zombie sessions entirely.

### Daemon

`src/daemon.ts` — Long-lived background process. Creates the BiDi session on startup, manages session lifecycle, handles cleanup on shutdown. Listens on TCP port 9223 for MCP server connections.

- Auto-started by the MCP server if not running
- Writes PID to `$TEMP/zen-mcp-daemon.pid`
- Saves `webSocketUrl` to `$TEMP/zen-mcp-session.json`
- Reconnects to existing sessions when MCP server reconnects
- Handles `connect`, `bidi`, `end-session`, `status` commands

### Daemon Client

`src/daemon-client.ts` — BiDiClient-compatible proxy used by the MCP server. Forwards all BiDi commands to the daemon over TCP. Provides the same interface as `BiDiClient` so tool modules don't need to know about the daemon.

### CLI

`src/cli.ts` — Daemon management commands:
- `zen-mcp daemon start` — Start daemon in background
- `zen-mcp daemon stop` — Stop daemon gracefully
- `zen-mcp daemon status` — Check if daemon is running

### Agent-Tab Isolation Model

The agent and user share the same browser but operate in separate tabs:

- **Agent tab**: Created automatically on first connect. All write operations (navigate, click, fill, etc.) target this tab by default.
- **User tabs**: The user browses freely in their own tabs. The agent can peek at any user tab (read-only) without interfering.
- **Explicit handoff**: If the user wants the agent to act on their tab, they use `zen_select_page` to switch the agent's target.

### Entry point

`src/index.ts` — Creates `McpServer`, registers 22 tools, starts `StdioServerTransport`. Connects to daemon on startup. On shutdown, disconnects from daemon (session persists).

### Tool modules (src/tools/)

| File        | Tools                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| browse.ts   | zen_list_pages, zen_select_page, zen_new_tab, zen_navigate, zen_close_tab                                |
| see.ts      | zen_snapshot, zen_screenshot, zen_get_page_text, zen_get_form_fields, zen_peek_screenshot, zen_peek_text |
| interact.ts | zen_click, zen_fill, zen_select_option, zen_check, zen_press_key, zen_fill_form, zen_scroll              |
| utility.ts  | zen_evaluate, zen_wait, zen_wait_for, zen_reconnect                                                      |

Tools accept either `BiDiClient` or `DaemonClient` via the `BrowserClient` type union. They call methods like `callFunction`, `evaluate`, `navigate`, etc. which inject JavaScript into the page via `script.callFunction` BiDi commands.

Peek tools (`zen_peek_screenshot`, `zen_peek_text`) accept a tab index and read from that tab without switching the agent's active context.

### Types

`src/types.ts` — BiDi protocol types, Zod v4 input schemas for all tools, `ToolResult` interface.

## Key facts

- **Protocol:** WebDriver BiDi (NOT CDP). Firefox/Gecko does not implement Chrome DevTools Protocol (removed in Firefox 141+).
- **Daemon port:** 9223 (TCP, localhost only). Configurable via `ZEN_MCP_DAEMON_PORT` env var.
- **Zod import:** `import { z } from "zod/v4"` — SDK requires Zod v4 API.
- **MCP SDK v1:** `@modelcontextprotocol/sdk` v1.29.0. Uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
- **Form filling:** Uses native value setters + `input`/`change` event dispatch for React/Vue/Angular compatibility.
- **Cross-platform paths** in error messages: macOS `/Applications/Zen.app/Contents/MacOS/zen`, Windows `C:\Program Files\Zen Browser\zen.exe`, Linux `zen` (in PATH).
- **SIGHUP handler** is skipped on Windows (not a valid signal on win32).
- `extractValue()` in `see.ts` is shared by all tool modules — it deserializes BiDi serialized results. It recursively unwraps BiDiResponse envelopes (`{type:"success", result: {type:"success", result: ...}}`) until reaching a real RemoteValue type (`string`, `number`, `object`, etc.).
- **Context-aware methods**: `callFunction()`, `evaluate()`, `screenshot()`, `performKeyActions()` all accept optional `contextId` parameter for peek operations.

## Gotchas

- `vp check` reports warnings from `node_modules/` — ignore those, they're not from project source.
- The `inputSchema` in `registerTool()` must use `.shape` (e.g., `NavigateSchema.shape`) to pass the Zod schema object, not the Zod type itself.
- Tool handlers must return objects matching the SDK's `CallToolResult` shape with an index signature — the `ToolResult` interface in `types.ts` handles this.
- Top-level `await` is used in `index.ts` (works because `"type": "module"` in package.json).
- BiDi sessions are exclusive — only one session at a time. The daemon manages this by keeping a single session alive permanently.
- The daemon is a detached background process. It stays alive after the MCP server exits. Use `zen-mcp daemon stop` to stop it.
- On Windows, `fileURLToPath(import.meta.url)` is used for path resolution (not `new URL().pathname` which has issues with drive letters).

## Testing

`tests/test-all-features.cjs` — Spawns the MCP server, sends MCP protocol messages over stdio, and tests all 22 tools against a live Zen Browser instance. Requires Zen running with `--remote-debugging-port 9222`.

Note: The daemon persists after test completion. Run `zen-mcp daemon stop` or kill the daemon process to clean up.

The test harness validates:

- MCP protocol handshake (initialize, tools/list)
- Navigation and page inspection (navigate, snapshot, screenshot, get_page_text)
- Interaction (click, fill, check, select_option, press_key, scroll)
- Tab management (new_tab, close_tab, select_page, peek_text, peek_screenshot)
- Utility tools (evaluate, wait, wait_for, reconnect)
