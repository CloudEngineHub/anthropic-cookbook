/**
 * Custom tool definitions exposed to the agent.
 * Keep this file the single source of truth — sessions-ui imports a JSON
 * copy of these so the two sides never drift.
 */

export const REPL_TOOL_NAME = "js_repl";
export const LIST_TOOL_NAME = "js_list_symbols";

export const REPL_TOOLS = [
  {
    type: "custom",
    name: REPL_TOOL_NAME,
    description:
      "Execute JavaScript in a persistent QuickJS sandbox. Top-level `var` and " +
      "`function` declarations survive across calls (persisted in durable storage), " +
      "so you can define a helper once and call it later. `console.log` is captured " +
      "and returned. The value of the last expression is the result. Errors surface " +
      "as `is_error` tool results with the stack trace. No network / async — this is " +
      "a pure-compute sandbox.",
    input_schema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript source. Previously defined symbols are in scope. " +
            "Use `var` or `function` (not `let`/`const`) for declarations " +
            "you want to persist across calls.",
        },
      },
      required: ["code"],
    },
  },
  {
    type: "custom",
    name: LIST_TOOL_NAME,
    description:
      "List every symbol (function/const/let) currently stored in the REPL's durable " +
      "storage, with a one-line preview. Call this before writing new code so you can " +
      "compose instead of re-implement.",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
] as const;

export type ReplToolName = typeof REPL_TOOL_NAME | typeof LIST_TOOL_NAME;
