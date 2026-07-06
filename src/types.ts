import { z } from "zod/v4";

// ─── BiDi Protocol Types ────────────────────────────────────────────

export interface BiDiMessage {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface BiDiResponse {
  id: number;
  type?: string;
  result?: BiDiResult;
  error?: { message: string; code: number };
}

export type BiDiResult =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "null" | "undefined" }
  | { type: "array"; value: BiDiResult[] }
  | { type: "object"; value: [BiDiResult, BiDiResult][] }
  | { type: string; value?: unknown };

export interface BrowsingContext {
  context: string;
  url?: string;
  children?: BrowsingContext[];
}

export interface SessionNewResult {
  sessionId: string;
}

export interface GetTreeResult {
  contexts: BrowsingContext[];
}

export interface NavigateResult {
  navigation: string;
}

export interface ScreenshotResult {
  data: string; // base64
}

export interface EvaluateResult {
  result: BiDiResult;
}

// ─── Tool Types ─────────────────────────────────────────────────────

// Matches the MCP SDK's CallToolResult shape with index signature
export interface ToolResult {
  content: Array<
    | { type: "text"; text: string; [key: string]: unknown }
    | { type: "image"; data: string; mimeType: string; [key: string]: unknown }
  >;
  isError?: boolean;
  [key: string]: unknown;
}

// ─── Tool Input Schemas (Zod) ──────────────────────────────────────

export const NavigateSchema = z.object({ url: z.string().describe("URL to navigate to") });

export const ListPagesSchema = z.object({});

export const SelectPageSchema = z.object({
  index: z.number().int().min(0).describe("Page index from zen_list_pages"),
});

export const NewTabSchema = z.object({
  url: z.string().optional().describe("URL to open (default: about:blank)"),
});

export const CloseTabSchema = z.object({
  index: z.number().int().min(0).describe("Tab index to close"),
});

export const SnapshotSchema = z.object({
  filter: z
    .enum(["all", "interactive", "form"])
    .optional()
    .describe("Element filter (default: all)"),
  selector: z.string().optional().describe("CSS selector to scope snapshot"),
});

export const ScreenshotSchema = z.object({});

export const GetPageTextSchema = z.object({
  maxLength: z.number().int().optional().describe("Max characters of body text (default: 8000)"),
});

export const GetFormFieldsSchema = z.object({});

export const ClickSchema = z.object({
  selector: z.string().describe("CSS selector of element to click"),
});

export const FillSchema = z.object({
  selector: z.string().describe("CSS selector of input/textarea"),
  value: z.string().describe("Value to fill"),
});

export const SelectOptionSchema = z.object({
  selector: z.string().describe("CSS selector of select element"),
  value: z.string().describe("Option value or visible text"),
});

export const CheckSchema = z.object({
  selector: z.string().describe("CSS selector of checkbox/radio"),
  checked: z.boolean().optional().describe("true=check, false=uncheck (default: true)"),
});

export const PressKeySchema = z.object({
  key: z.string().describe("Key name: Enter, Tab, Escape, Backspace, ArrowDown, etc."),
  modifiers: z
    .array(z.enum(["ctrl", "shift", "alt", "meta"]))
    .optional()
    .describe("Modifier keys to hold"),
});

export const FillFormSchema = z.object({
  fields: z
    .array(
      z.object({
        selector: z.string(),
        value: z.string(),
        action: z.enum(["fill", "select", "check", "uncheck", "click"]).optional(),
      }),
    )
    .describe("Fields to fill"),
});

export const ScrollSchema = z.object({
  direction: z
    .enum(["up", "down", "top", "bottom"])
    .optional()
    .describe("Scroll direction (default: down)"),
  amount: z.number().optional().describe("Pixels (default: 500)"),
  selector: z.string().optional().describe("Element to scroll into view"),
});

export const EvaluateSchema = z.object({
  script: z.string().describe("JavaScript to evaluate"),
});

export const WaitSchema = z.object({
  ms: z.number().optional().describe("Milliseconds to wait (default: 1000)"),
});

export const WaitForSchema = z.object({
  text: z.string().optional().describe("Text to wait for on the page"),
  selector: z.string().optional().describe("CSS selector to wait for"),
  timeout: z.number().optional().describe("Max wait time in ms (default: 10000)"),
});

export const ReconnectSchema = z.object({});

export const PeekScreenshotSchema = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .describe("Tab index from zen_list_pages (default: user's active tab)"),
});

export const PeekTextSchema = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .describe("Tab index from zen_list_pages (default: user's active tab)"),
  maxLength: z.number().int().optional().describe("Max characters of body text (default: 8000)"),
});
