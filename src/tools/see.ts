import type { BiDiClient } from "../bidi-client.js";
import type { BiDiResult, ToolResult } from "../types.js";
import { text } from "./browse.js";

export function registerSeeTools(bidi: BiDiClient) {
  return {
    zen_snapshot: async (args: { filter?: string; selector?: string }): Promise<ToolResult> => {
      const filter = args?.filter || "all";
      const sel = args?.selector || null;
      const result = await bidi.callFunction(
        `
        function(filter, sel) {
          const scope = sel ? document.querySelector(sel) : document;
          if (!scope) return { error: 'Selector not found: ' + sel };

          const selectorMap = {
            all: 'input, textarea, select, button, a, [role="button"], [role="link"], [role="checkbox"], [role="radio"], h1, h2, h3, h4, h5, h6, p, label, li',
            interactive: 'input, textarea, select, button, a, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [contenteditable]',
            form: 'input, textarea, select',
          };

          const elements = scope.querySelectorAll(selectorMap[filter] || selectorMap.all);
          const items = [];

          elements.forEach((el) => {
            const tag = el.tagName.toLowerCase();
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return;
            if (getComputedStyle(el).display === 'none') return;

            let selector = tag;
            if (el.id) selector = '#' + el.id;
            else if (el.name) selector = tag + '[name="' + el.name + '"]';
            else if (el.getAttribute('aria-label')) selector = tag + '[aria-label="' + el.getAttribute('aria-label') + '"]';

            const info = { tag, selector };
            if (el.type) info.type = el.type;
            if (el.name) info.name = el.name;
            if (el.id) info.id = el.id;
            if (el.value !== undefined && el.value !== '') info.value = String(el.value).substring(0, 200);
            if (el.placeholder) info.placeholder = el.placeholder;
            if (el.checked !== undefined) info.checked = el.checked;
            if (el.href) info.href = el.href;
            const role = el.getAttribute('role');
            if (role) info.role = role;
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) info.ariaLabel = ariaLabel;

            const label = el.closest('label')?.textContent?.trim()?.substring(0, 100)
              || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent?.trim()?.substring(0, 100))
              || '';
            if (label) info.label = label;

            if (!['input', 'textarea', 'select'].includes(tag)) {
              const txt = el.textContent?.trim()?.substring(0, 120);
              if (txt) info.text = txt;
            }

            items.push(info);
          });

          return { count: items.length, elements: items };
        }
      `,
        [
          { type: "string", value: filter },
          { type: "string", value: sel || "" },
        ],
      );
      return text(JSON.stringify(extractValue(result), null, 2));
    },

    zen_screenshot: async (): Promise<ToolResult> => {
      const result = await bidi.screenshot();
      if (result.data) {
        return { content: [{ type: "image", data: result.data, mimeType: "image/png" }] };
      }
      return text("Screenshot captured (no data returned)");
    },

    zen_get_page_text: async (args: { maxLength?: number }): Promise<ToolResult> => {
      const maxLen = args?.maxLength || 8000;
      const result = await bidi.callFunction(
        `
        function(maxLen) {
          return {
            title: document.title,
            url: location.href,
            text: document.body.innerText.substring(0, maxLen),
          };
        }
      `,
        [{ type: "number", value: maxLen }],
      );
      return text(JSON.stringify(extractValue(result), null, 2));
    },

    zen_get_form_fields: async (): Promise<ToolResult> => {
      const result = await bidi.callFunction(`
        function() {
          return Array.from(document.querySelectorAll('input, textarea, select')).map((el, i) => {
            const tag = el.tagName.toLowerCase();
            const rect = el.getBoundingClientRect();
            let selector = tag;
            if (el.id) selector = '#' + el.id;
            else if (el.name) selector = tag + '[name="' + el.name + '"]';

            const label = el.closest('label')?.textContent?.trim()?.substring(0, 100)
              || (el.id && document.querySelector('label[for="' + el.id + '"]')?.textContent?.trim()?.substring(0, 100))
              || '';

            let options;
            if (tag === 'select') {
              options = Array.from(el.options).map(o => ({
                value: o.value, text: o.textContent.trim(), selected: o.selected,
              }));
            }

            return {
              index: i, tag, type: el.type || '', name: el.name || '',
              id: el.id || '', selector, value: (el.value || '').substring(0, 200),
              placeholder: el.placeholder || '', label,
              checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
              required: el.required || false, disabled: el.disabled || false,
              visible: rect.width > 0 && rect.height > 0, options,
            };
          });
        }
      `);
      return text(JSON.stringify(extractValue(result), null, 2));
    },

    /** Peek at a user's tab without switching the agent's active context. */
    zen_peek_screenshot: async (args: { index: number }): Promise<ToolResult> => {
      const ctxId = await bidi.getContextByIndex(args.index);
      const result = await bidi.screenshot(ctxId);
      if (result.data) {
        return { content: [{ type: "image", data: result.data, mimeType: "image/png" }] };
      }
      return text("Screenshot captured (no data returned)");
    },

    /** Get text from a user's tab without switching the agent's active context. */
    zen_peek_text: async (args: { index: number; maxLength?: number }): Promise<ToolResult> => {
      const maxLen = args?.maxLength || 8000;
      const ctxId = await bidi.getContextByIndex(args.index);
      const result = await bidi.callFunction(
        `
        function(maxLen) {
          return {
            title: document.title,
            url: location.href,
            text: document.body.innerText.substring(0, maxLen),
          };
        }
      `,
        [{ type: "number", value: maxLen }],
        ctxId,
      );
      return text(JSON.stringify(extractValue(result), null, 2));
    },
  };
}

export function extractValue(result: unknown): unknown {
  if (!result) return undefined;

  // Unwrap BiDiResponse envelope(s).
  // Zen's BiDi can return double-wrapped responses:
  //   { type: "success", result: { type: "success", result: { type: "object", value: [...] } } }
  // The actual RemoteResult has a type like "string"|"number"|"object"|etc.
  // Keep unwrapping while we see type:"success" with a nested result.
  let r: BiDiResult = result as BiDiResult;
  while (
    r &&
    (r as unknown as { type?: string }).type === "success" &&
    (r as unknown as { result?: unknown }).result &&
    typeof (r as unknown as { result?: unknown }).result === "object"
  ) {
    r = (r as unknown as { result: BiDiResult }).result;
  }

  if (r.type === "string") return r.value;
  if (r.type === "number") return r.value;
  if (r.type === "boolean") return r.value;
  if (r.type === "null" || r.type === "undefined") return null;
  if (r.type === "array") return (r.value as BiDiResult[])?.map(extractValue);
  if (r.type === "object") {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of r.value as [BiDiResult, BiDiResult][]) {
      obj[typeof k === "string" ? k : String((k as { value: unknown }).value)] = extractValue(v);
    }
    return obj;
  }
  if (r.type === "node") {
    return { __biDiNode: true, sharedId: (r as { sharedId?: string }).sharedId };
  }
  return (r as { value?: unknown }).value ?? r;
}
