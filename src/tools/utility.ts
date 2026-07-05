import type { BiDiClient } from "../bidi-client.js";
import type { ToolResult } from "../types.js";
import { text } from "./browse.js";
import { extractValue } from "./see.js";

export function registerUtilityTools(bidi: BiDiClient) {
  return {
    zen_evaluate: async (args: { script: string }): Promise<ToolResult> => {
      let script = args.script;
      if (script.includes(";") && !script.startsWith("(")) {
        script = `(() => { ${script} })()`;
      }
      const result = await bidi.evaluate(script);
      return text(JSON.stringify(extractValue(result), null, 2));
    },

    zen_wait: async (args: { ms?: number }): Promise<ToolResult> => {
      const ms = args?.ms || 1000;
      await new Promise((r) => setTimeout(r, ms));
      return text(`Waited ${ms}ms`);
    },

    zen_wait_for: async (args: {
      text?: string;
      selector?: string;
      timeout?: number;
    }): Promise<ToolResult> => {
      const timeout = args?.timeout || 10000;
      const pollInterval = 250;
      const maxPolls = Math.ceil(timeout / pollInterval);

      for (let i = 0; i < maxPolls; i++) {
        try {
          if (args?.text) {
            const result = await bidi.callFunction(
              `
              function(searchText) {
                return document.body.innerText.includes(searchText);
              }
            `,
              [{ type: "string", value: args.text }],
            );
            if (extractValue(result) === true) {
              return text(`Found text "${args.text}" after ${i * pollInterval}ms`);
            }
          } else if (args?.selector) {
            const result = await bidi.callFunction(
              `
              function(sel) {
                return document.querySelector(sel) !== null;
              }
            `,
              [{ type: "string", value: args.selector }],
            );
            if (extractValue(result) === true) {
              return text(`Found selector "${args.selector}" after ${i * pollInterval}ms`);
            }
          } else {
            return text('Provide either "text" or "selector" to wait for.');
          }
        } catch {
          // Page might be navigating, swallow error and retry
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      const target = args?.text ? `text "${args.text}"` : `selector "${args?.selector}"`;
      return text(`Timeout after ${timeout}ms: ${target} not found`);
    },

    zen_reconnect: async (): Promise<ToolResult> => {
      try {
        await bidi.disconnect();
      } catch {}
      bidi.resetIntentionalDisconnect();
      await bidi.connect();
      return text(`Reconnected to Zen Browser. Session active.`);
    },
  };
}
