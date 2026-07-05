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

### Entry point

`src/index.ts` — creates `McpServer`, registers 20 tools, starts `StdioServerTransport`.

### Core module

`src/bidi-client.ts` — `BiDiClient` class. Manages WebSocket lifecycle, BiDi sessions, auto-reconnect (exponential backoff, 3 attempts), zombie session recovery. All browser interaction goes through this client.

### Tool modules (src/tools/)

| File | Tools |
|---|---|
| browse.ts | zen_list_pages, zen_select_page, zen_new_tab, zen_navigate, zen_close_tab |
| see.ts | zen_snapshot, zen_screenshot, zen_get_page_text, zen_get_form_fields |
| interact.ts | zen_click, zen_fill, zen_select_option, zen_check, zen_press_key, zen_fill_form, zen_scroll |
| utility.ts | zen_evaluate, zen_wait, zen_wait_for, zen_reconnect |

Tools are plain async functions, not classes. They call `BiDiClient` methods (`callFunction`, `evaluate`, `navigate`, etc.) which inject JavaScript into the page via `script.callFunction` BiDi commands.

### Types

`src/types.ts` — BiDi protocol types, Zod v4 input schemas for all tools, `ToolResult` interface.

## Key facts

- **Protocol:** WebDriver BiDi (NOT CDP). Firefox/Gecko does not implement Chrome DevTools Protocol.
- **Zod import:** `import { z } from "zod/v4"` — SDK requires Zod v4 API.
- **MCP SDK v1:** `@modelcontextprotocol/sdk` v1.29.0. Uses `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`.
- **Form filling:** Uses native value setters + `input`/`change` event dispatch for React/Vue/Angular compatibility.
- **Cross-platform paths** in error messages: macOS `/Applications/Zen.app/Contents/MacOS/zen`, Windows `C:\Program Files\Zen Browser\zen.exe`, Linux `zen` (in PATH).
- **SIGHUP handler** is skipped on Windows (not a valid signal on win32).
- `extractValue()` in `see.ts` is shared by all tool modules — it deserializes BiDi serialized results.

## Gotchas

- `vp check` reports warnings from `node_modules/` — ignore those, they're not from project source.
- The `inputSchema` in `registerTool()` must use `.shape` (e.g., `NavigateSchema.shape`) to pass the Zod schema object, not the Zod type itself.
- Tool handlers must return objects matching the SDK's `CallToolResult` shape with an index signature — the `ToolResult` interface in `types.ts` handles this.
- Top-level `await` is used in `index.ts` (works because `"type": "module"` in package.json).
