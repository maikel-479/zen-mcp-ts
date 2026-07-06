import type { BiDiClient } from "../bidi-client.js";
import type { ToolResult } from "../types.js";

export function registerBrowseTools(bidi: BiDiClient) {
  return {
    zen_list_pages: async (): Promise<ToolResult> => {
      const contexts = await bidi.getContexts();
      const agentCtx = bidi.agentContext;
      const pages = contexts.map((ctx, i) => ({
        index: i,
        contextId: ctx.context,
        url: ctx.url || "",
        active: ctx.context === bidi.currentContext,
        isAgentTab: ctx.context === agentCtx,
        children: ctx.children?.length || 0,
      }));
      return text(JSON.stringify(pages, null, 2));
    },

    zen_select_page: async (args: { index: number }): Promise<ToolResult> => {
      const contexts = await bidi.getContexts();
      if (args.index < 0 || args.index >= contexts.length) {
        return text(`Invalid index ${args.index}. ${contexts.length} pages available.`);
      }
      bidi.currentContext = contexts[args.index].context;
      const isAgent = contexts[args.index].context === bidi.agentContext;
      return text(
        `Selected page ${args.index}: ${contexts[args.index].url}` +
          (isAgent ? " (agent tab)" : " (user tab — agent will operate here)"),
      );
    },

    zen_new_tab: async (args: { url?: string }): Promise<ToolResult> => {
      const ctx = await bidi.createTab(args?.url || "about:blank");
      return text(`New tab created: ${ctx}` + (args?.url ? ` at ${args.url}` : ""));
    },

    zen_navigate: async (args: { url: string }): Promise<ToolResult> => {
      const result = await bidi.navigate(args.url);
      return text(`Navigated to ${args.url} (navigation: ${result.navigation})`);
    },

    zen_close_tab: async (args: { index: number }): Promise<ToolResult> => {
      const contexts = await bidi.getContexts();
      if (contexts.length <= 1) {
        return text("Cannot close the last remaining tab.");
      }
      if (args.index < 0 || args.index >= contexts.length) {
        return text(`Invalid index ${args.index}. ${contexts.length} tabs available.`);
      }
      const ctxToClose = contexts[args.index].context;
      await bidi.closeTab(ctxToClose);
      return text(`Closed tab ${args.index}: ${contexts[args.index].url || "about:blank"}`);
    },
  };
}

export function text(str: string): ToolResult {
  return { content: [{ type: "text", text: str }] };
}
