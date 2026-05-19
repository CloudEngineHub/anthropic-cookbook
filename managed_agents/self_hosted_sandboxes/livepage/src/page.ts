import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import { parse, HTMLElement } from "node-html-parser";
import { TOOL_NAMES, isPageTool, type PageToolName } from "./tools";
import type { Env, PageEdit, SessionEvent, ToolUse } from "./types";

const SESSION_KEY = "session";
const CURSOR_KEY = "cursor";
const HTML_KEY = "html";
const EDIT_PREFIX = "edit:";
const HANDLED_PREFIX = "done:";

const IDLE_LINGER_MS = 5 * 60_000;

const SCAFFOLD = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>livepage</title>
  <style id="base">
    :root{--fg:#1a1a1a;--bg:#fafaf8;--accent:#d97757;--muted:#666}
    *{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
    header,main,footer{max-width:880px;margin:0 auto;padding:2rem 1.5rem}
    h1{font-size:clamp(2rem,5vw,3.5rem);line-height:1.1;margin:0 0 .5rem}
    h2{font-size:1.5rem;margin:2rem 0 .5rem}
    p{margin:.5rem 0}a{color:var(--accent)}
    .muted{color:var(--muted);font-size:.9em}
  </style>
</head>
<body>
  <header id="hero">
    <h1>Untitled</h1>
    <p class="muted">edit me by talking</p>
  </header>
  <main id="content"></main>
  <footer id="footer"></footer>
</body>
</html>`;

/**
 * One Durable Object per Anthropic session. Holds the live HTML document
 * in durable storage and re-renders it from scratch (scaffold + ordered
 * edits) on cold start so the document is always consistent with the
 * tool_use history the agent sees.
 */
export class LivePage extends DurableObject<Env> {
  private client: Anthropic;
  private doc: HTMLElement | null = null;

  /** SSE subscribers watching the page; pushed on every edit. */
  private watchers = new Set<WritableStreamDefaultWriter<string>>();

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

  // ---------------------------------------------------------------------------
  // Webhook lifecycle
  // ---------------------------------------------------------------------------

  async wake(sessionId: string): Promise<void> {
    const bound = await this.ctx.storage.get<string>(SESSION_KEY);
    if (bound && bound !== sessionId) {
      console.error("[livepage] session id mismatch", { bound, sessionId });
      return;
    }
    if (!bound) await this.ctx.storage.put(SESSION_KEY, sessionId);

    // Listener already running (possibly in idle-linger) — skip.
    if (this.streaming) return;

    await this.hydrate();
    await this.drainDangling(sessionId);

    this.abort = new AbortController();
    this.streaming = this.listen(sessionId, this.abort.signal)
      .catch((e) => console.error("[livepage] listen crashed", sessionId, e))
      .finally(() => {
        this.streaming = null;
        this.abort = null;
      });
    this.ctx.waitUntil(this.streaming);
  }

  async sleep(): Promise<void> {
    // No-op — the listener's idle-linger timer drives exit.
  }

  async terminate(): Promise<void> {
    this.abort?.abort();
  }

  async reset(): Promise<void> {
    this.abort?.abort();
    await this.ctx.storage.deleteAll();
    this.doc = null;
    for (const w of this.watchers) {
      try {
        await w.close();
      } catch {}
    }
    this.watchers.clear();
  }

  // ---------------------------------------------------------------------------
  // Public readers
  // ---------------------------------------------------------------------------

  /** Current HTML — hydrates on first access. */
  async html(): Promise<string> {
    await this.hydrate();
    return this.doc!.toString();
  }

  /**
   * Streams can't cross the RPC boundary, so the worker routes /watch
   * here via DO.fetch() instead of stub.watch().
   */
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/watch") {
      return new Response("not found", { status: 404 });
    }
    await this.hydrate();
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream<string, Uint8Array>({
      transform(chunk, ctrl) {
        ctrl.enqueue(enc.encode(chunk));
      },
    });
    const w = writable.getWriter();
    this.watchers.add(w);
    await w.write(sseEvent("html", this.doc!.toString()));
    w.closed.finally(() => this.watchers.delete(w));
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  async dump(): Promise<{
    sessionId: string | null;
    cursor: string | null;
    edits: number;
    handled: number;
    watchers: number;
  }> {
    const sessionId =
      (await this.ctx.storage.get<string>(SESSION_KEY)) ?? null;
    const cursor = (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? null;
    const edits = await this.ctx.storage.list({ prefix: EDIT_PREFIX });
    const handled = await this.ctx.storage.list({ prefix: HANDLED_PREFIX });
    return {
      sessionId,
      cursor,
      edits: edits.size,
      handled: handled.size,
      watchers: this.watchers.size,
    };
  }

  // ---------------------------------------------------------------------------
  // Dangling tool_use scan
  // ---------------------------------------------------------------------------

  private async drainDangling(sessionId: string): Promise<void> {
    const handled = new Set(
      [...(await this.ctx.storage.list({ prefix: HANDLED_PREFIX })).keys()].map(
        (k) => k.slice(HANDLED_PREFIX.length),
      ),
    );

    const dangling = new Map<string, ToolUse>();
    let cursor =
      (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? undefined;
    if (cursor && !cursor.startsWith("page_")) cursor = undefined;
    let lastId: string | undefined;

    for (;;) {
      const resp = (await this.client.beta.sessions.events.list(sessionId, {
        page: cursor,
        limit: 100,
      } as never)) as unknown as {
        data: SessionEvent[];
        has_more: boolean;
        next_page?: string | null;
      };
      for (const ev of resp.data) {
        if (ev.id) lastId = ev.id;
        for (const use of extractToolUses(ev)) {
          if (isPageTool(use.toolName) && !handled.has(use.toolUseId)) {
            dangling.set(use.toolUseId, use);
          }
        }
        for (const rid of extractToolResultIds(ev)) {
          dangling.delete(rid);
        }
      }
      cursor = resp.next_page ?? undefined;
      if (!resp.has_more || !cursor) break;
    }

    for (const use of dangling.values()) {
      await this.handleToolUse(sessionId, use);
    }
    const persist = cursor ?? lastId;
    if (persist) await this.ctx.storage.put(CURSOR_KEY, persist);
  }

  private async listen(sessionId: string, signal: AbortSignal): Promise<void> {
    const stream = this.client.beta.sessions.stream(sessionId, { signal });

    let linger: ReturnType<typeof setTimeout> | null = null;
    const startLinger = () => {
      if (linger) return;
      linger = setTimeout(() => this.abort?.abort(), IDLE_LINGER_MS);
    };
    const cancelLinger = () => {
      if (linger) {
        clearTimeout(linger);
        linger = null;
      }
    };

    let lastId: string | undefined;
    try {
      for await (const raw of await stream) {
        if (signal.aborted) break;
        const ev = raw as unknown as SessionEvent;
        if (ev.id) lastId = ev.id;

        if (ev.type === "status_closed") break;
        if (ev.type === "status_idle") {
          if (lastId) await this.ctx.storage.put(CURSOR_KEY, lastId);
          startLinger();
          continue;
        }
        cancelLinger();

        for (const use of extractToolUses(ev)) {
          if (isPageTool(use.toolName)) {
            await this.handleToolUse(sessionId, use);
          }
        }
      }
    } finally {
      cancelLinger();
      if (lastId) await this.ctx.storage.put(CURSOR_KEY, lastId);
    }
  }

  private async handleToolUse(
    sessionId: string,
    use: ToolUse,
  ): Promise<void> {
    const doneKey = HANDLED_PREFIX + use.toolUseId;
    if (await this.ctx.storage.get<boolean>(doneKey)) return;

    const { text, isError } = await this.runTool(
      use.toolName as PageToolName,
      use.input,
    );

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
  // Tool dispatch
  // ---------------------------------------------------------------------------

  private async runTool(
    name: PageToolName,
    input: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }> {
    await this.hydrate();
    const doc = this.doc!;

    switch (name) {
      case TOOL_NAMES.getPage:
        return ok(doc.toString());

      case TOOL_NAMES.setHtml: {
        const sel = str(input.selector);
        const html = str(input.html);
        const el = doc.querySelector(sel);
        if (!el) return err(`no match for selector "${sel}"`);
        el.innerHTML = html;
        await this.commit({ kind: "set_html", selector: sel, html });
        return ok(`set ${sel} (${html.length} chars)`);
      }

      case TOOL_NAMES.addBlock: {
        const anchor = str(input.anchor);
        const pos = str(input.position) as PageEdit extends {
          kind: "add_block";
        }
          ? Extract<PageEdit, { kind: "add_block" }>["position"]
          : never;
        const html = str(input.html);
        const el = doc.querySelector(anchor);
        if (!el) return err(`no match for anchor "${anchor}"`);
        const frag = parse(html);
        switch (pos) {
          case "append":
            el.appendChild(frag);
            break;
          case "prepend":
            el.childNodes.unshift(...frag.childNodes);
            frag.childNodes.forEach((c) => (c.parentNode = el));
            break;
          case "before":
            el.insertAdjacentHTML("beforebegin", html);
            break;
          case "after":
            el.insertAdjacentHTML("afterend", html);
            break;
          default:
            return err(`bad position "${pos}"`);
        }
        await this.commit({
          kind: "add_block",
          anchor,
          position: pos,
          html,
        });
        return ok(`inserted ${pos} ${anchor} (${html.length} chars)`);
      }

      case TOOL_NAMES.remove: {
        const sel = str(input.selector);
        const el = doc.querySelector(sel);
        if (!el) return err(`no match for "${sel}"`);
        el.remove();
        await this.commit({ kind: "remove", selector: sel });
        return ok(`removed ${sel}`);
      }

      case TOOL_NAMES.setStyle: {
        const css = str(input.css);
        const id = input.id ? str(input.id) : undefined;
        const head = doc.querySelector("head")!;
        if (id) {
          const existing = head.querySelector(`style#${id}`);
          if (existing) {
            existing.innerHTML = css;
          } else {
            head.insertAdjacentHTML(
              "beforeend",
              `<style id="${id}">${css}</style>`,
            );
          }
        } else {
          head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
        }
        await this.commit({ kind: "set_style", css, id });
        return ok(`style ${id ?? "(anon)"} (${css.length} chars)`);
      }

      case TOOL_NAMES.setAttr: {
        const sel = str(input.selector);
        const aname = str(input.name);
        const aval = str(input.value);
        const el = doc.querySelector(sel);
        if (!el) return err(`no match for "${sel}"`);
        el.setAttribute(aname, aval);
        await this.commit({
          kind: "set_attr",
          selector: sel,
          name: aname,
          value: aval,
        });
        return ok(`${sel}[${aname}="${aval}"]`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Document state
  // ---------------------------------------------------------------------------

  private async hydrate(): Promise<void> {
    if (this.doc) return;
    const stored = await this.ctx.storage.get<string>(HTML_KEY);
    this.doc = parse(stored ?? SCAFFOLD);
  }

  private async commit(edit: PageEdit): Promise<void> {
    const html = this.doc!.toString();
    const key =
      EDIT_PREFIX + Date.now().toString().padStart(16, "0");
    await this.ctx.storage.put({
      [HTML_KEY]: html,
      [key]: edit,
    });
    await this.broadcast(html);
  }

  private async broadcast(html: string): Promise<void> {
    const chunk = sseEvent("html", html);
    for (const w of this.watchers) {
      try {
        await w.write(chunk);
      } catch {
        this.watchers.delete(w);
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers (pure)
// -----------------------------------------------------------------------------

function ok(text: string): { text: string; isError: boolean } {
  return { text, isError: false };
}
function err(text: string): { text: string; isError: boolean } {
  return { text, isError: true };
}
function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function sseEvent(name: string, data: string): string {
  return (
    `event: ${name}\n` +
    data
      .split("\n")
      .map((l) => `data: ${l}`)
      .join("\n") +
    "\n\n"
  );
}

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
