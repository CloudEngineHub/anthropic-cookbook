/**
 * Custom tool definitions — fetched by sessions-ui's Cloud REPL section
 * from /tools and merged into agent.tools at session-create time.
 */

export const TOOL_NAMES = {
  goto: "browser_goto",
  click: "browser_click",
  type: "browser_type",
  select: "browser_select",
  scroll: "browser_scroll",
  read: "browser_read",
  screenshot: "browser_screenshot",
  back: "browser_back",
  canvas: "browser_canvas",
} as const;

export type BrowserToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const ALL = new Set<string>(Object.values(TOOL_NAMES));
export function isBrowserTool(name: string): name is BrowserToolName {
  return ALL.has(name);
}

export const BROWSER_TOOLS = [
  {
    type: "custom",
    name: TOOL_NAMES.goto,
    description:
      "Navigate the browser to a URL and wait for the page to load. " +
      "Returns the final URL (after redirects) and the page title. " +
      "Call this first — the browser starts at about:blank.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute URL (http/https).",
        },
      },
      required: ["url"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.read,
    description:
      "Extract a simplified, numbered view of the current page: visible text " +
      "content + clickable elements (links, buttons, inputs) tagged with " +
      "stable indices like [12]. Use those indices as `target` in " +
      "browser_click/browser_type — they survive across your calls within " +
      "the same page. Call this after every navigation or significant DOM " +
      "change so your indices stay fresh.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: TOOL_NAMES.click,
    description:
      "Click an element. `target` MUST be a [N] index from the most recent " +
      "browser_read call — do NOT pass button/link text or guess CSS " +
      "selectors. If you don't have a fresh index for the element you want, " +
      "call browser_read first. Waits for any navigation that follows.",
    input_schema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "'[N]' index from browser_read, e.g. '[12]'. Nothing else.",
        },
      },
      required: ["target"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.type,
    description:
      "Focus an input/textarea and type into it. `target` MUST be a [N] " +
      "index from browser_read. Optionally press Enter afterwards " +
      "(`submit: true`).",
    input_schema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "'[N]' index from browser_read, e.g. '[8]'.",
        },
        text: { type: "string" },
        submit: {
          type: "boolean",
          description: "Press Enter after typing. Default false.",
        },
      },
      required: ["target", "text"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.select,
    description:
      "Set the value of a <select> dropdown. Use this instead of clicking " +
      "<option> elements — those aren't clickable via the browser's native " +
      "UI. `target` is the [N] index of the <select> (from browser_read) or " +
      "a CSS selector; `value` is the option's value attribute (NOT its " +
      "visible text).",
    input_schema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "'[N]' index or CSS selector for the <select> element.",
        },
        value: {
          type: "string",
          description:
            "The <option>'s value attribute. If you only know the visible " +
            "text, browser_read shows the select's options.",
        },
      },
      required: ["target", "value"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.scroll,
    description: "Scroll the viewport vertically. Positive = down.",
    input_schema: {
      type: "object",
      properties: {
        dy: {
          type: "number",
          description: "Pixels. 800 is roughly one screen.",
        },
      },
      required: ["dy"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.back,
    description: "Navigate back in history.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: TOOL_NAMES.screenshot,
    description:
      "Capture the current viewport and return it as an image block so you " +
      "can see what the page looks like. Heavier than browser_read — use " +
      "when the text extraction isn't enough (layout matters, image content, " +
      "verifying a form looks right before submit).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: TOOL_NAMES.canvas,
    description:
      "Render arbitrary HTML/SVG to the live viewer panel so the human " +
      "watching can see a visualisation of what you're working on. Use this " +
      "liberally to keep the viewer in the loop. Examples: an SVG family " +
      "tree with the node you're currently investigating highlighted; a " +
      "progress checklist with ✓/○ per step; a table of search results " +
      "you've collected so far; a status line explaining why you're " +
      "retrying. Each call replaces the previous canvas — re-render the " +
      "whole thing, don't try to patch.",
    input_schema: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description:
            "Full HTML/SVG fragment. Rendered inside a dark-themed panel " +
            "(background #262626, text #ddd) — style accordingly. Inline " +
            "<style> blocks work. Keep it under ~4KB; larger is truncated.",
        },
      },
      required: ["html"],
    },
  },
] as const;
