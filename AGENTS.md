# zen-mcp-ts

MCP server for Zen Browser automation via WebDriver BiDi over WebSocket.

## Commands

```bash
vp exec tsc          # Build (TypeScript → dist/)
vp check             # Format + lint + type check
vp check --fix       # Auto-fix formatting
node dist/index.js   # Run server (requires Zen with --remote-debugging-port 9222)
```

`vp build` does NOT work — this is a Node.js CLI project, not a Vite web app. Always use `vp exec tsc`.

## Architecture

Single MCP server process communicating over stdio (MCP) and WebSocket (BiDi).

```
AI Client ──stdio/MCP──> zen-mcp-ts ──WebSocket/BiDi──> Zen Browser (port 9222)
```

### Agent-Tab Isolation Model

The agent and user share the same browser but operate in separate tabs:

- **Agent tab**: Created automatically on first connect. All write operations (navigate, click, fill, etc.) target this tab by default.
- **User tabs**: The user browses freely in their own tabs. The agent can peek at any user tab (read-only) without interfering.
- **Explicit handoff**: If the user wants the agent to act on their tab, they use `zen_select_page` to switch the agent's target.

This mirrors how Perplexity Comet and Atlas (OWL) handle user-agent coexistence — isolated contexts with explicit access grants.

### Entry point

`src/index.ts` — creates `McpServer`, registers 22 tools, starts `StdioServerTransport`.

### Core module

`src/bidi-client.ts` — `BiDiClient` class. Manages WebSocket lifecycle, BiDi sessions, auto-reconnect (exponential backoff, 3 attempts), zombie session recovery, and agent tab management. All browser interaction goes through this client.

Key properties:

- `_agentContext` — The tab created for the agent. Set on first connect.
- `_currentContext` — The tab currently targeted by write operations. Defaults to agent tab, can be switched via `zen_select_page`.

### Tool modules (src/tools/)

| File        | Tools                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| browse.ts   | zen_list_pages, zen_select_page, zen_new_tab, zen_navigate, zen_close_tab                                |
| see.ts      | zen_snapshot, zen_screenshot, zen_get_page_text, zen_get_form_fields, zen_peek_screenshot, zen_peek_text |
| interact.ts | zen_click, zen_fill, zen_select_option, zen_check, zen_press_key, zen_fill_form, zen_scroll              |
| utility.ts  | zen_evaluate, zen_wait, zen_wait_for, zen_reconnect                                                      |

Tools are plain async functions, not classes. They call `BiDiClient` methods (`callFunction`, `evaluate`, `navigate`, etc.) which inject JavaScript into the page via `script.callFunction` BiDi commands.

Peek tools (`zen_peek_screenshot`, `zen_peek_text`) accept a tab index and read from that tab without switching the agent's active context.

### Types

`src/types.ts` — BiDi protocol types, Zod v4 input schemas for all tools, `ToolResult` interface.

## Key facts

- **Protocol:** WebDriver BiDi (NOT CDP). Firefox/Gecko does not implement Chrome DevTools Protocol (removed in Firefox 141+).
- **Zod import:** `import { z } from "zod/v4"` — SDK requires Zod v4 API.
- **MCP SDK v1:** `@modelcontextprotocol/sdk` v1.29.0. Uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
- **Form filling:** Uses native value setters + `input`/`change` event dispatch for React/Vue/Angular compatibility.
- **Cross-platform paths** in error messages: macOS `/Applications/Zen.app/Contents/MacOS/zen`, Windows `C:\Program Files\Zen Browser\zen.exe`, Linux `zen` (in PATH).
- **SIGHUP handler** is skipped on Windows (not a valid signal on win32).
- `extractValue()` in `see.ts` is shared by all tool modules — it deserializes BiDi serialized results.
- **Context-aware methods**: `callFunction()`, `evaluate()`, `screenshot()`, `performKeyActions()` all accept optional `contextId` parameter for peek operations.

## Gotchas

- `vp check` reports warnings from `node_modules/` — ignore those, they're not from project source.
- The `inputSchema` in `registerTool()` must use `.shape` (e.g., `NavigateSchema.shape`) to pass the Zod schema object, not the Zod type itself.
- Tool handlers must return objects matching the SDK's `CallToolResult` shape with an index signature — the `ToolResult` interface in `types.ts` handles this.
- Top-level `await` is used in `index.ts` (works because `"type": "module"` in package.json).
- BiDi sessions are exclusive — only one session at a time. The agent reuses sessions when possible and creates new ones only when needed.
