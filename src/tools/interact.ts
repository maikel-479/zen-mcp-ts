import type { BiDiClient } from "../bidi-client.js";
import type { ToolResult } from "../types.js";
import { text } from "./browse.js";
import { extractValue } from "./see.js";

export function registerInteractTools(bidi: BiDiClient) {
  return {
    zen_click: async (args: { selector: string }): Promise<ToolResult> => {
      const MAX_RETRIES = 5;
      const DELAY_MS = 200;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const result = await bidi.callFunction(
          `
          function(sel) {
            const el = document.querySelector(sel);
            if (!el) return null;
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { clicked: sel };
          }
        `,
          [{ type: "string", value: args.selector }],
        );

        const val = extractValue(result);
        if (val !== null && val !== undefined) {
          return text(JSON.stringify(val));
        }

        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
        }
      }

      return text(JSON.stringify({ error: "Element not found: " + args.selector }));
    },

    zen_fill: async (args: { selector: string; value: string }): Promise<ToolResult> => {
      const result = await bidi.callFunction(
        `
        function(sel, val) {
          const el = document.querySelector(sel);
          if (!el) return { error: 'Not found: ' + sel };
          el.focus();
          el.scrollIntoView({ block: 'center' });

          const proto = el.tagName === 'TEXTAREA'
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val);
          else el.value = val;

          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          return { filled: sel, value: el.value.substring(0, 100) };
        }
      `,
        [
          { type: "string", value: args.selector },
          { type: "string", value: args.value },
        ],
      );
      return text(JSON.stringify(extractValue(result)));
    },

    zen_select_option: async (args: { selector: string; value: string }): Promise<ToolResult> => {
      const result = await bidi.callFunction(
        `
        function(sel, val) {
          const select = document.querySelector(sel);
          if (!select) return { error: 'Not found: ' + sel };
          const option = Array.from(select.options).find(
            o => o.value === val || o.textContent.trim() === val
          );
          if (!option) return { error: 'Option not found: ' + val };
          select.value = option.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { selected: option.value, text: option.textContent.trim() };
        }
      `,
        [
          { type: "string", value: args.selector },
          { type: "string", value: args.value },
        ],
      );
      return text(JSON.stringify(extractValue(result)));
    },

    zen_check: async (args: { selector: string; checked?: boolean }): Promise<ToolResult> => {
      const shouldCheck = args.checked !== false;
      const result = await bidi.callFunction(
        `
        function(sel, check) {
          const el = document.querySelector(sel);
          if (!el) return { error: 'Not found: ' + sel };
          el.scrollIntoView({ block: 'center' });
          if (el.checked !== check) el.click();
          return { selector: sel, checked: el.checked };
        }
      `,
        [
          { type: "string", value: args.selector },
          { type: "boolean", value: shouldCheck },
        ],
      );
      return text(JSON.stringify(extractValue(result)));
    },

    zen_press_key: async (args: { key: string; modifiers?: string[] }): Promise<ToolResult> => {
      const keyMap: Record<string, string> = {
        Enter: "\uE006",
        Tab: "\uE004",
        Escape: "\uE00C",
        Backspace: "\uE003",
        Delete: "\uE017",
        Space: " ",
        ArrowUp: "\uE013",
        ArrowDown: "\uE015",
        ArrowLeft: "\uE012",
        ArrowRight: "\uE014",
        Home: "\uE011",
        End: "\uE010",
        PageUp: "\uE00E",
        PageDown: "\uE00F",
      };
      const modMap: Record<string, string> = {
        ctrl: "\uE009",
        shift: "\uE008",
        alt: "\uE00A",
        meta: "\uE03D",
      };

      const keyValue = keyMap[args.key] || args.key;
      const mods = args.modifiers || [];
      const actions: Array<{ type: string; value: string }> = [];

      for (const mod of mods) {
        if (modMap[mod]) actions.push({ type: "keyDown", value: modMap[mod] });
      }
      actions.push({ type: "keyDown", value: keyValue });
      actions.push({ type: "keyUp", value: keyValue });
      for (let i = mods.length - 1; i >= 0; i--) {
        if (modMap[mods[i]]) actions.push({ type: "keyUp", value: modMap[mods[i]] });
      }

      await bidi.performKeyActions(actions);
      const modStr = mods.length > 0 ? mods.join("+") + "+" : "";
      return text(`Pressed ${modStr}${args.key}`);
    },

    zen_fill_form: async (args: {
      fields: Array<{ selector: string; value: string; action?: string }>;
    }): Promise<ToolResult> => {
      const results: Array<{ selector: string; action: string; status: string; error?: string }> =
        [];
      for (const field of args.fields) {
        const action = field.action || "fill";
        try {
          let fn: string;
          let fnArgs: Array<{ type: string; value: unknown }>;

          if (action === "fill") {
            fn = `function(sel, val) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              el.focus();
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, val);
              else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }`;
            fnArgs = [
              { type: "string", value: field.selector },
              { type: "string", value: field.value },
            ];
          } else if (action === "select") {
            fn = `function(sel, val) {
              const s = document.querySelector(sel);
              if (!s) return { error: 'Not found: ' + sel };
              const opt = Array.from(s.options).find(o => o.value === val || o.textContent.trim() === val);
              if (!opt) return { error: 'Option not found: ' + val };
              s.value = opt.value;
              s.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            }`;
            fnArgs = [
              { type: "string", value: field.selector },
              { type: "string", value: field.value },
            ];
          } else if (action === "check") {
            fn = `function(sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              if (!el.checked) el.click();
              return { ok: true, checked: el.checked };
            }`;
            fnArgs = [{ type: "string", value: field.selector }];
          } else if (action === "uncheck") {
            fn = `function(sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              if (el.checked) el.click();
              return { ok: true, checked: el.checked };
            }`;
            fnArgs = [{ type: "string", value: field.selector }];
          } else {
            fn = `function(sel) {
              const el = document.querySelector(sel);
              if (!el) return { error: 'Not found: ' + sel };
              el.click();
              return { ok: true };
            }`;
            fnArgs = [{ type: "string", value: field.selector }];
          }

          const result = await bidi.callFunction(fn, fnArgs);
          const val = extractValue(result) as Record<string, unknown> | undefined;
          results.push({
            selector: field.selector,
            action,
            ...(val?.error ? { status: "error", error: String(val.error) } : { status: "ok" }),
          });
        } catch (e) {
          results.push({
            selector: field.selector,
            action,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      return text(JSON.stringify(results, null, 2));
    },

    zen_scroll: async (args: {
      direction?: string;
      amount?: number;
      selector?: string;
    }): Promise<ToolResult> => {
      if (args?.selector) {
        await bidi.callFunction(
          `
          function(sel) { document.querySelector(sel)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        `,
          [{ type: "string", value: args.selector }],
        );
        return text(`Scrolled ${args.selector} into view`);
      }
      const dir = args?.direction || "down";
      const amt = args?.amount || 500;
      await bidi.callFunction(
        `
        function(dir, amt) {
          if (dir === 'down') window.scrollBy(0, amt);
          else if (dir === 'up') window.scrollBy(0, -amt);
          else if (dir === 'top') window.scrollTo(0, 0);
          else if (dir === 'bottom') window.scrollTo(0, document.body.scrollHeight);
        }
      `,
        [
          { type: "string", value: dir },
          { type: "number", value: amt },
        ],
      );
      return text(`Scrolled ${dir} ${amt}px`);
    },
  };
}
