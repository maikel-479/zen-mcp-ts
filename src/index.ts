#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DaemonClient } from "./daemon-client.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerSeeTools } from "./tools/see.js";
import { registerInteractTools } from "./tools/interact.js";
import { registerUtilityTools } from "./tools/utility.js";
import {
  NavigateSchema,
  ListPagesSchema,
  SelectPageSchema,
  NewTabSchema,
  CloseTabSchema,
  SnapshotSchema,
  ScreenshotSchema,
  GetPageTextSchema,
  GetFormFieldsSchema,
  ClickSchema,
  FillSchema,
  SelectOptionSchema,
  CheckSchema,
  PressKeySchema,
  FillFormSchema,
  ScrollSchema,
  EvaluateSchema,
  WaitSchema,
  WaitForSchema,
  ReconnectSchema,
  PeekScreenshotSchema,
  PeekTextSchema,
} from "./types.js";

function log(...args: unknown[]) {
  console.error("[zen-mcp]", ...args);
}

const bidi = new DaemonClient();
const browseTools = registerBrowseTools(bidi);
const seeTools = registerSeeTools(bidi);
const interactTools = registerInteractTools(bidi);
const utilityTools = registerUtilityTools(bidi);

const server = new McpServer({
  name: "zen-browser",
  version: "2.0.0",
});

// ─── Browse Tools ───────────────────────────────────────────────────

server.registerTool(
  "zen_list_pages",
  {
    description:
      "List all open tabs. The agent's own tab is marked [agent]. User tabs are safe to peek at.",
    inputSchema: ListPagesSchema.shape,
  },
  async () => browseTools.zen_list_pages(),
);

server.registerTool(
  "zen_select_page",
  {
    description:
      "Switch the agent's active target to a specific tab by index. The agent will operate on that tab until you select another.",
    inputSchema: SelectPageSchema.shape,
  },
  async (args) => browseTools.zen_select_page(args as { index: number }),
);

server.registerTool(
  "zen_new_tab",
  {
    description: "Open a new tab, optionally navigating to a URL",
    inputSchema: NewTabSchema.shape,
  },
  async (args) => browseTools.zen_new_tab(args as { url?: string }),
);

server.registerTool(
  "zen_navigate",
  {
    description: "Navigate the active page to a URL",
    inputSchema: NavigateSchema.shape,
  },
  async (args) => browseTools.zen_navigate(args as { url: string }),
);

server.registerTool(
  "zen_close_tab",
  {
    description: "Close a tab by index. Cannot close the last remaining tab.",
    inputSchema: CloseTabSchema.shape,
  },
  async (args) => browseTools.zen_close_tab(args as { index: number }),
);

// ─── See Tools ──────────────────────────────────────────────────────

server.registerTool(
  "zen_snapshot",
  {
    description:
      'Get a structured snapshot of visible page elements with CSS selectors. Filter: "all", "interactive", or "form".',
    inputSchema: SnapshotSchema.shape,
  },
  async (args) => seeTools.zen_snapshot(args as { filter?: string; selector?: string }),
);

server.registerTool(
  "zen_screenshot",
  {
    description: "Take a screenshot of the agent's current active tab",
    inputSchema: ScreenshotSchema.shape,
  },
  async () => seeTools.zen_screenshot(),
);

server.registerTool(
  "zen_get_page_text",
  {
    description:
      "Get the page title, URL, and visible text content from the agent's current active tab.",
    inputSchema: GetPageTextSchema.shape,
  },
  async (args) => seeTools.zen_get_page_text(args as { maxLength?: number }),
);

server.registerTool(
  "zen_get_form_fields",
  {
    description:
      "List all form fields on the page with names, types, labels, current values, and CSS selectors",
    inputSchema: GetFormFieldsSchema.shape,
  },
  async () => seeTools.zen_get_form_fields(),
);

server.registerTool(
  "zen_peek_screenshot",
  {
    description:
      "Peek at a user's tab by index — take a screenshot without switching the agent's active context. Use zen_list_pages to see tab indices.",
    inputSchema: PeekScreenshotSchema.shape,
  },
  async (args) => seeTools.zen_peek_screenshot(args as { index: number }),
);

server.registerTool(
  "zen_peek_text",
  {
    description:
      "Peek at a user's tab by index — get page text without switching the agent's active context. Use zen_list_pages to see tab indices.",
    inputSchema: PeekTextSchema.shape,
  },
  async (args) => seeTools.zen_peek_text(args as { index: number; maxLength?: number }),
);

// ─── Interact Tools ─────────────────────────────────────────────────

server.registerTool(
  "zen_click",
  {
    description: "Click an element by CSS selector in the agent's active tab",
    inputSchema: ClickSchema.shape,
  },
  async (args) => interactTools.zen_click(args as { selector: string }),
);

server.registerTool(
  "zen_fill",
  {
    description:
      "Fill a text input or textarea with a value. Clears existing content first. Dispatches input/change events for framework compatibility.",
    inputSchema: FillSchema.shape,
  },
  async (args) => interactTools.zen_fill(args as { selector: string; value: string }),
);

server.registerTool(
  "zen_select_option",
  {
    description: "Select an option in a <select> dropdown by value or text",
    inputSchema: SelectOptionSchema.shape,
  },
  async (args) => interactTools.zen_select_option(args as { selector: string; value: string }),
);

server.registerTool(
  "zen_check",
  {
    description: "Check/uncheck a checkbox or select a radio button",
    inputSchema: CheckSchema.shape,
  },
  async (args) => interactTools.zen_check(args as { selector: string; checked?: boolean }),
);

server.registerTool(
  "zen_press_key",
  {
    description:
      "Send keyboard input to the active page using BiDi input.performActions. Supports special keys like Enter, Tab, Escape, Backspace, and key combinations with modifiers.",
    inputSchema: PressKeySchema.shape,
  },
  async (args) => interactTools.zen_press_key(args as { key: string; modifiers?: string[] }),
);

server.registerTool(
  "zen_fill_form",
  {
    description:
      "Fill multiple form fields at once. Each field specifies selector, value, and action (fill/select/check/uncheck/click).",
    inputSchema: FillFormSchema.shape,
  },
  async (args) =>
    interactTools.zen_fill_form(
      args as { fields: Array<{ selector: string; value: string; action?: string }> },
    ),
);

server.registerTool(
  "zen_scroll",
  {
    description: "Scroll the page or scroll an element into view",
    inputSchema: ScrollSchema.shape,
  },
  async (args) =>
    interactTools.zen_scroll(args as { direction?: string; amount?: number; selector?: string }),
);

// ─── Utility Tools ──────────────────────────────────────────────────

server.registerTool(
  "zen_evaluate",
  {
    description: "Execute JavaScript in the page and return the result",
    inputSchema: EvaluateSchema.shape,
  },
  async (args) => utilityTools.zen_evaluate(args as { script: string }),
);

server.registerTool(
  "zen_wait",
  {
    description: "Wait for a specified number of milliseconds",
    inputSchema: WaitSchema.shape,
  },
  async (args) => utilityTools.zen_wait(args as { ms?: number }),
);

server.registerTool(
  "zen_wait_for",
  {
    description:
      "Wait for text to appear on the page, or for a CSS selector to match an element. Returns when found or after timeout.",
    inputSchema: WaitForSchema.shape,
  },
  async (args) =>
    utilityTools.zen_wait_for(args as { text?: string; selector?: string; timeout?: number }),
);

server.registerTool(
  "zen_reconnect",
  {
    description:
      "Force disconnect and reconnect to Zen Browser. Use when the connection is in a bad state or after restarting Zen.",
    inputSchema: ReconnectSchema.shape,
  },
  async () => utilityTools.zen_reconnect(),
);

// ─── Cleanup ────────────────────────────────────────────────────────

let transport: StdioServerTransport;

async function gracefulShutdown(signal: string) {
  log(`Received ${signal}, cleaning up...`);
  try {
    await bidi.disconnect();
  } catch {}
  process.exit(0);
}

process.stdin.on("end", () => {
  log("stdin ended");
  bidi
    .disconnect()
    .catch(() => {})
    .finally(() => process.exit(0));
});
process.stdin.on("close", () => {
  log("stdin closed");
  bidi.disconnect().catch(() => {});
});

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
if (process.platform !== "win32") {
  process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
}

process.on("uncaughtException", async (err) => {
  console.error("uncaughtException:", err);
  await bidi.disconnect().catch(() => {});
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  console.error("unhandledRejection:", reason);
  await bidi.disconnect().catch(() => {});
  process.exit(1);
});

process.on("beforeExit", async () => {
  try {
    await bidi.disconnect();
  } catch {}
});

process.on("exit", (code) => {
  log(`process exiting with code ${code}`);
});

// ─── Start Server ───────────────────────────────────────────────────

async function main() {
  log("Connecting to daemon...");
  await bidi.connect();
  log("Connected to daemon, session:", bidi.sessionId);

  transport = new StdioServerTransport();
  transport.onclose = async () => {
    log("Transport closed");
    await bidi.disconnect();
    process.exit(0);
  };
  await server.connect(transport);
  log("MCP server ready");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
