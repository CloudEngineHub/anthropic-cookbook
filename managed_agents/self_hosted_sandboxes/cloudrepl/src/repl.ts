import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { JsSandbox } from "./quickjs";
import { LIST_TOOL_NAME, REPL_TOOL_NAME } from "./tools";
import type { Env, SessionEvent, StoredSnippet, ToolUse } from "./types";

const SESSION_KEY = "session"; // the sessionId this DO is bound to
const CURSOR_KEY = "cursor"; // next_page cursor from events.list
const SNIPPET_PREFIX = "snip:"; // persisted code defining scope symbols
const HANDLED_PREFIX = "done:"; // tool_use_ids we've already replied to

/**
 * One Durable Object per Anthropic session. Holds the REPL scope in durable
 * storage so it survives isolate eviction, worker redeploys, and the worker
 * going to sleep between agent turns.
 *
 * Invariant: every `tool_use` event for one of our tools eventually gets a
 * `tool_result` posted, even if the worker crashed mid-handle or was asleep
 * when the agent emitted it. We guarantee this by re-scanning the event list
 * on every wake and using the `done:` idempotency set as the source of truth
 * for "already replied" — the cursor is purely a page-skip optimisation.
 *
 * Code runs inside a QuickJS-WASM interpreter (not the host V8), because
 * Workers blocks `new Function()`. Each DO instance keeps one live QuickJS
 * context whose globals survive across REPL calls; the context is rebuilt
 * from durable snippets on cold start.
 */
export class ReplSession extends DurableObject<Env> {
  private client: Anthropic;
  private sandbox: JsSandbox | null = null;

  /** Non-null while a stream loop is active. */
  private streaming: Promise<void> | null = null;
  private abort: AbortController | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
      defaultHeaders: { "anthropic-beta": env.ANTHROPIC_BETA },
    });
  }

  /** RPC: session.running webhook. */
  async wake(sessionId: string): Promise<void> {
    // idFromName(sessionId) already isolates storage per session, but we
    // persist the id so dump() can report it and a stray cross-session wake
    // would be visible.
    const bound = await this.ctx.storage.get<string>(SESSION_KEY);
    if (bound && bound !== sessionId) {
      console.error("[repl] session id mismatch", { bound, sessionId });
      return;
    }
    if (!bound) await this.ctx.storage.put(SESSION_KEY, sessionId);

    await this.ensureSandbox();

    // Always drain dangling tool_uses first — these block the agent and the
    // webhook that woke us almost certainly fired because one is waiting.
    await this.drainDangling(sessionId);

    if (this.streaming) return;
    this.abort = new AbortController();
    this.streaming = this.listen(sessionId, this.abort.signal)
      .catch((e) => console.error("[repl] listen crashed", sessionId, e))
      .finally(() => {
        this.streaming = null;
        this.abort = null;
      });
    this.ctx.waitUntil(this.streaming);
  }

  /** RPC: session.idled / archived / deleted webhook. */
  async sleep(): Promise<void> {
    this.abort?.abort();
  }

  /** RPC: manual purge from the worker's /reset route. */
  async reset(): Promise<void> {
    this.abort?.abort();
    await this.ctx.storage.deleteAll();
    this.sandbox?.dispose();
    this.sandbox = null;
  }

  /** RPC: manual inspection from the worker's /state route. */
  async dump(): Promise<{
    sessionId: string | null;
    symbols: string[];
    cursor: string | null;
    handled: number;
  }> {
    await this.ensureSandbox();
    const sessionId =
      (await this.ctx.storage.get<string>(SESSION_KEY)) ?? null;
    const cursor = (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? null;
    const handled = await this.ctx.storage.list({ prefix: HANDLED_PREFIX });
    const symbols = this.sandbox!.listGlobals().map((g) => g.name);
    return { sessionId, symbols, cursor, handled: handled.size };
  }

  // ---------------------------------------------------------------------------
  // Dangling tool_use scan
  // ---------------------------------------------------------------------------

  /**
   * List events from the last scanned cursor forward, collect any tool_use
   * events for our tools that (a) don't have a later tool_result and (b)
   * aren't in our `done:` set, then handle them.
   *
   * Runs on every wake — cheap when the cursor is near-current, and the only
   * thing that makes the "agent stuck waiting for a reply" case impossible
   * to wedge.
   */
  private async drainDangling(sessionId: string): Promise<void> {
    const handled = new Set(
      [
        ...(await this.ctx.storage.list({ prefix: HANDLED_PREFIX })).keys(),
      ].map((k) => k.slice(HANDLED_PREFIX.length)),
    );

    const dangling = new Map<string, ToolUse>();
    let cursor =
      (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? undefined;
    // Guard against stale cursors from the pre-page_ schema.
    if (cursor && !cursor.startsWith("page_")) cursor = undefined;

    for (;;) {
      const resp = (await this.client.beta.sessions.events.list(sessionId, {
        page: cursor,
        limit: 100,
      } as never)) as unknown as {
        data: SessionEvent[];
        has_more: boolean;
        next_page?: string | null;
      };
      for (const raw of resp.data) {
        for (const use of extractToolUses(raw)) {
          if (isOurs(use.toolName) && !handled.has(use.toolUseId)) {
            dangling.set(use.toolUseId, use);
          }
        }
        for (const rid of extractToolResultIds(raw)) {
          dangling.delete(rid);
        }
      }
      if (resp.next_page) cursor = resp.next_page;
      if (!resp.has_more) break;
    }

    for (const use of dangling.values()) {
      await this.handleToolUse(sessionId, use);
    }

    if (cursor) await this.ctx.storage.put(CURSOR_KEY, cursor);
  }

  // ---------------------------------------------------------------------------
  // Live stream
  // ---------------------------------------------------------------------------

  private async listen(sessionId: string, signal: AbortSignal): Promise<void> {
    const stream = this.client.beta.sessions.stream(sessionId, { signal });
    for await (const raw of await stream) {
      if (signal.aborted) break;
      const ev = raw as unknown as SessionEvent;
      for (const use of extractToolUses(ev)) {
        if (isOurs(use.toolName)) {
          await this.handleToolUse(sessionId, use);
        }
      }
      if (ev.type === "status_idle" || ev.type === "status_closed") break;
    }
  }

  // ---------------------------------------------------------------------------
  // Handle a single tool_use
  // ---------------------------------------------------------------------------

  private async handleToolUse(sessionId: string, use: ToolUse): Promise<void> {
    const doneKey = HANDLED_PREFIX + use.toolUseId;
    if (await this.ctx.storage.get<boolean>(doneKey)) return;

    const { text, isError } =
      use.toolName === REPL_TOOL_NAME
        ? await this.runRepl(String(use.input.code ?? ""))
        : this.runList();

    await this.client.beta.sessions.events.send(sessionId, {
      events: [
        {
          type: "tool_result",
          tool_use_id: use.toolUseId,
          is_error: isError,
          content: [{ type: "text", text }],
        } as never,
      ],
    });

    await this.ctx.storage.put(doneKey, true);
  }

  // ---------------------------------------------------------------------------
  // REPL evaluation
  // ---------------------------------------------------------------------------

  private async ensureSandbox(): Promise<void> {
    if (this.sandbox) return;
    this.sandbox = await JsSandbox.create();

    const stored = await this.ctx.storage.list<StoredSnippet>({
      prefix: SNIPPET_PREFIX,
    });
    const ordered = [...stored.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [, snip] of ordered) {
      this.sandbox.replay(snip.source);
    }
  }

  private async runRepl(
    code: string,
  ): Promise<{ text: string; isError: boolean }> {
    if (!code.trim()) return { text: "Error: empty code", isError: true };

    const names = extractDeclaredNames(code);
    const { ok, result, logs } = this.sandbox!.eval(code);

    if (!ok) {
      const out = [...logs, result].join("\n");
      return { text: out, isError: true };
    }

    if (names.length > 0) {
      const key = SNIPPET_PREFIX + Date.now().toString().padStart(16, "0");
      await this.ctx.storage.put<StoredSnippet>(key, {
        names,
        source: code,
        createdAt: Date.now(),
      });
    }

    const out = [
      ...(logs.length > 0 ? ["# console", ...logs, ""] : []),
      ...(names.length > 0 ? [`# defined: ${names.join(", ")}`] : []),
      "# result",
      result,
    ].join("\n");
    return { text: out, isError: false };
  }

  private runList(): { text: string; isError: boolean } {
    const syms = this.sandbox!.listGlobals();
    if (syms.length === 0) {
      return { text: "(empty — no symbols defined yet)", isError: false };
    }
    const lines = syms.map(
      (s) => `- ${s.name}: ${s.kind}  ${s.preview}`,
    );
    return { text: lines.join("\n"), isError: false };
  }
}

// -----------------------------------------------------------------------------
// Helpers (pure)
// -----------------------------------------------------------------------------

function isOurs(name: string): boolean {
  return name === REPL_TOOL_NAME || name === LIST_TOOL_NAME;
}

/**
 * Normalise the three wire shapes we see for tool_use events:
 *   1. flat `{type:"tool_use", tool_name, tool_use_id, input}` (SALT beta)
 *   2. flat `{type:"custom_tool_use", ...}` (legacy naming)
 *   3. nested inside `{type:"agent", content:[{type:"tool_use", id, name, input}]}`
 */
function extractToolUses(ev: SessionEvent): ToolUse[] {
  if (ev.type === "tool_use" || ev.type === "custom_tool_use") {
    if (ev.tool_use_id && ev.tool_name) {
      return [
        {
          toolUseId: ev.tool_use_id,
          toolName: ev.tool_name,
          input: ev.input ?? {},
        },
      ];
    }
    return [];
  }
  if (ev.type === "agent" && Array.isArray(ev.content)) {
    const out: ToolUse[] = [];
    for (const b of ev.content) {
      if (b.type === "tool_use" && b.id && b.name) {
        out.push({ toolUseId: b.id, toolName: b.name, input: b.input ?? {} });
      }
    }
    return out;
  }
  return [];
}

/** Same normalisation for tool_result ids (so dangling-scan can cancel them). */
function extractToolResultIds(ev: SessionEvent): string[] {
  if (ev.type === "tool_result" || ev.type === "custom_tool_result") {
    return ev.tool_use_id ? [ev.tool_use_id] : [];
  }
  if (ev.type === "agent" && Array.isArray(ev.content)) {
    return ev.content
      .filter((b) => b.type === "tool_result" && b.tool_use_id)
      .map((b) => b.tool_use_id!);
  }
  return [];
}

const DECL_RE = /^\s*(?:var\s+(\w+)|function\s+(\w+))/gm;

function extractDeclaredNames(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(DECL_RE)) {
    const n = m[1] ?? m[2];
    if (n) out.add(n);
  }
  return [...out];
}
