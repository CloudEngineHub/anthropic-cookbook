/**
 * Custom tool definitions exposed to the agent.
 * sessions-ui fetches these from /tools and merges them into agent.tools.
 */

export const TOOL_NAMES = {
  setHtml: "page_set_html",
  addBlock: "page_add_block",
  remove: "page_remove",
  setStyle: "page_set_style",
  setAttr: "page_set_attr",
  getPage: "page_get",
} as const;

export type PageToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

const ALL_NAMES = new Set<string>(Object.values(TOOL_NAMES));
export function isPageTool(name: string): name is PageToolName {
  return ALL_NAMES.has(name);
}

export const PAGE_TOOLS = [
  {
    type: "custom",
    name: TOOL_NAMES.getPage,
    description:
      "Fetch the current HTML of the live page you're editing. Call this first " +
      "(and again after big changes) so you know what selectors exist. The page " +
      "starts as a minimal scaffold with <header id=\"hero\">, <main id=\"content\">, " +
      "and <footer id=\"footer\"> — every element you add should get an id or class " +
      "so you (and later calls) can target it.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    type: "custom",
    name: TOOL_NAMES.setHtml,
    description:
      "Replace the innerHTML of the first element matching a CSS selector. " +
      "Use for rewriting headlines, swapping a whole section's body, etc. " +
      "If the selector matches nothing, returns an error.",
    input_schema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector (id, class, tag). Matched against the live document.",
        },
        html: {
          type: "string",
          description: "Replacement innerHTML. Keep ids on structural elements so later edits can target them.",
        },
      },
      required: ["selector", "html"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.addBlock,
    description:
      "Insert a new HTML block relative to an anchor element. " +
      "position=append|prepend adds inside the anchor; before|after adds as a sibling. " +
      "Give every block you add an id — future calls will need it.",
    input_schema: {
      type: "object",
      properties: {
        anchor: {
          type: "string",
          description: "CSS selector for the reference element.",
        },
        position: {
          type: "string",
          enum: ["before", "after", "append", "prepend"],
        },
        html: { type: "string" },
      },
      required: ["anchor", "position", "html"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.remove,
    description: "Delete the first element matching the selector.",
    input_schema: {
      type: "object",
      properties: { selector: { type: "string" } },
      required: ["selector"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.setStyle,
    description:
      "Append or replace a <style> block. Pass an id to replace an existing " +
      "style block (so iterating on the same rule doesn't pile up duplicates); " +
      "omit id for a fresh one.",
    input_schema: {
      type: "object",
      properties: {
        css: { type: "string" },
        id: {
          type: "string",
          description: "Optional. If set, replaces the <style id=…> instead of appending.",
        },
      },
      required: ["css"],
    },
  },
  {
    type: "custom",
    name: TOOL_NAMES.setAttr,
    description:
      "Set a single attribute on the first matching element. Use for hrefs, " +
      "src, data-* attributes, etc.",
    input_schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
      },
      required: ["selector", "name", "value"],
    },
  },
] as const;
