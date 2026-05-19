import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";
import { EXTRACT_SCRIPT, type ExtractResult } from "./extract";
import { TOOL_NAMES, isBrowserTool, type BrowserToolName } from "./tools";
import type {
  BrowserSnapshot,
  Env,
  SessionEvent,
  ToolUse,
} from "./types";

const SESSION_KEY = "session";
const CURSOR_KEY = "cursor";
const HANDLED_PREFIX = "done:";
const SNAPSHOT_KEY = "snap";
const SHOT_KEY = "shot"; // latest screenshot (jpeg bytes as ArrayBuffer)
const MAP_KEY = "map"; // [N] → selector bridge from last browser_read
const CANVAS_KEY = "canvas"; // agent-rendered HTML/SVG shown in /viewport

const NAV_TIMEOUT = 20_000;
const KEEPALIVE_MS = 60_000; // close browser this long after listener exits
const IDLE_LINGER_MS = 5 * 60_000; // keep SSE open after status_idle — back-to-back turns re-run inside the same stream

/**
 * One DO per Anthropic session. Holds an in-memory puppeteer page while
 * the session is running, snapshots cookies+url to storage on sleep, and
 * reuses an existing Browser Rendering session across DO evictions when
 * one is available (puppeteer.sessions()).
 */
export class BrowserSession extends DurableObject<Env> {
  private anthropic: Anthropic;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private indexMap: Record<string, string> = {};
  private lastUrl: string | null = null;
  private lastTool: string | null = null;

  private streaming: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private closeTimer: number | null = null;

  /** SSE subscribers to /watch — pinged on every captureAsync + state change. */
  private watchers = new Set<WritableStreamDefaultWriter<string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.anthropic = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
      defaultHeaders: { "anthropic-beta": env.ANTHROPIC_BETA },
    });
  }

  // ---------------------------------------------------------------------------
  // Webhook lifecycle
  // ---------------------------------------------------------------------------

  async wake(sessionId: string): Promise<void> {
    const t0 = Date.now();
    const bound = await this.ctx.storage.get<string>(SESSION_KEY);
    if (bound && bound !== sessionId) {
      console.error("[browseruse] session id mismatch", { bound, sessionId });
      return;
    }

    // Webhooks are org-scoped — every session's idled event hits us,
    // including sessions that never registered browser_* tools. Check
    // once (cached) and bail before launching an expensive browser.
    if (!bound) {
      if (!(await this.sessionHasOurTools(sessionId))) {
        console.log("[wake] session has no browser tools — ignoring", {
          sessionId,
        });
        return;
      }
      await this.ctx.storage.put(SESSION_KEY, sessionId);
    }

    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }

    // If the listener's already running, its poll loop will catch whatever
    // triggered this webhook on its next tick. If not, start it.
    if (this.streaming) {
      console.log("[wake] listener up", { ms: Date.now() - t0 });
      return;
    }

    // Warm the browser while the listener starts polling.
    this.ctx.waitUntil(
      this.ensurePage().catch((e) =>
        console.warn("[wake] browser launch failed", e),
      ),
    );

    this.abort = new AbortController();
    this.streaming = this.listen(sessionId, this.abort.signal)
      .catch((e) => console.error("[listen] crashed", sessionId, e))
      .finally(() => {
        this.streaming = null;
        this.abort = null;
        void this.snapshot();
        this.closeTimer = setTimeout(
          () => void this.closeBrowser(),
          KEEPALIVE_MS,
        ) as unknown as number;
        console.log("[listen] exited", { totalMs: Date.now() - t0 });
        void this.broadcastState();
      });
    this.ctx.waitUntil(this.streaming);
    void this.broadcastState();
  }

  /**
   * Fetch the session's agent config and check whether any of its
   * tools[] match our browser_* names. Called once on first wake;
   * thereafter the SESSION_KEY binding short-circuits it.
   */
  private async sessionHasOurTools(sessionId: string): Promise<boolean> {
    try {
      const s = (await this.anthropic.beta.sessions.retrieve(
        sessionId,
      )) as unknown as {
        agent?: { tools?: Array<{ name?: string; type?: string }> };
      };
      const tools = s.agent?.tools ?? [];
      return tools.some((t) => t.name && isBrowserTool(t.name));
    } catch (e) {
      console.warn("[wake] failed to fetch session — assuming no tools", {
        sessionId,
        error: String(e),
      });
      return false;
    }
  }

  async sleep(): Promise<void> {
    // No-op. The listener's idle-linger timer drives the actual exit; the
    // only webhook we act on synchronously is archived/deleted (below).
  }

  async terminate(): Promise<void> {
    this.abort?.abort();
    await this.snapshot();
    await this.closeBrowser();
  }

  async reset(): Promise<void> {
    this.abort?.abort();
    await this.closeBrowser();
    await this.ctx.storage.deleteAll();
    this.indexMap = {};
    this.scannedUpTo = null;
  }

  // ---------------------------------------------------------------------------
  // Public readers
  // ---------------------------------------------------------------------------

  async screenshot(): Promise<ArrayBuffer | null> {
    const buf = await this.ctx.storage.get<ArrayBuffer>(SHOT_KEY);
    return buf ?? null;
  }

  /**
   * Streams can't cross DO RPC, so the worker routes /watch here via
   * DO.fetch(). Emits `frame` events when a screenshot lands and `state`
   * events carrying the dump() JSON — viewport fetches /screenshot.jpg
   * only on `frame` instead of polling.
   */
  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/watch") {
      return new Response("not found", { status: 404 });
    }
    const enc = new TextEncoder();
    const { readable, writable } = new TransformStream<string, Uint8Array>({
      transform(chunk, ctrl) {
        ctrl.enqueue(enc.encode(chunk));
      },
    });
    const w = writable.getWriter();
    this.watchers.add(w);
    w.closed.finally(() => this.watchers.delete(w));
    // Initial state + frame ping — fire-and-forget so we return the
    // Response before the TransformStream buffer fills and blocks.
    void (async () => {
      try {
        await w.write(sseEvent("state", JSON.stringify(await this.dump())));
        await w.write(sseEvent("frame", ""));
        // Keepalive — Cloudflare's edge drops idle SSE after ~100s.
        // A ping every 25s keeps the pipe open when nothing else is
        // broadcasting.
        while (true) {
          await new Promise((r) => setTimeout(r, 25_000));
          await w.write(": ping\n\n");
        }
      } catch {
        this.watchers.delete(w);
      }
    })();
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }

  private async broadcast(name: string, data: string): Promise<void> {
    const chunk = sseEvent(name, data);
    for (const w of this.watchers) {
      try {
        await w.write(chunk);
      } catch {
        this.watchers.delete(w);
      }
    }
  }

  private async broadcastState(): Promise<void> {
    if (this.watchers.size === 0) return;
    await this.broadcast("state", JSON.stringify(await this.dump()));
  }

  async dump(): Promise<{
    sessionId: string | null;
    cursor: string | null;
    handled: number;
    hasBrowser: boolean;
    url: string | null;
    listening: boolean;
    canvas: string | null;
    lastTool: string | null;
  }> {
    const sessionId =
      (await this.ctx.storage.get<string>(SESSION_KEY)) ?? null;
    const cursor = (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? null;
    const handled = await this.ctx.storage.list({ prefix: HANDLED_PREFIX });
    const canvas = (await this.ctx.storage.get<string>(CANVAS_KEY)) ?? null;
    const live = this.pageLive();
    return {
      sessionId,
      cursor,
      handled: handled.size,
      hasBrowser: live,
      url: live ? this.lastUrl : null,
      listening: this.streaming !== null,
      canvas,
      lastTool: this.lastTool,
    };
  }

  private pageLive(): boolean {
    return (
      this.page !== null &&
      !this.page.isClosed() &&
      this.browser !== null &&
      this.browser.isConnected()
    );
  }

  // ---------------------------------------------------------------------------
  // Dangling tool_use scan (same pattern as livepage/cloudrepl)
  // ---------------------------------------------------------------------------

  /** In-memory high-water mark — events before this id were already
   * processed this DO lifetime. Resets on eviction (safe — full re-scan,
   * done: dedups). Lets the poll loop skip O(n) re-processing of old
   * events every tick. */
  private scannedUpTo: string | null = null;

  private async drainDangling(
    sessionId: string,
  ): Promise<{ terminal: boolean; sawRunning: boolean }> {
    const handled = new Set(
      [...(await this.ctx.storage.list({ prefix: HANDLED_PREFIX })).keys()].map(
        (k) => k.slice(HANDLED_PREFIX.length),
      ),
    );

    const dangling = new Map<string, ToolUse>();
    let terminal = false;
    let sawRunning = false;
    // Track the last browser_canvas input even if it already has a
    // result — lets us re-persist the canvas after a /reset or DO
    // eviction without needing the agent to re-call the tool.
    let lastCanvasHtml: string | null = null;
    let cursor =
      (await this.ctx.storage.get<string>(CURSOR_KEY)) ?? undefined;
    if (cursor && !cursor.startsWith("page_")) cursor = undefined;
    let lastId: string | undefined;
    let skipping = this.scannedUpTo !== null;

    for (;;) {
      // limit=1000 keeps most sessions single-page → one tunnel RTT per tick.
      const resp = (await this.anthropic.beta.sessions.events.list(
        sessionId,
        { page: cursor, limit: 1000 } as never,
      )) as unknown as {
        data: SessionEvent[];
        has_more: boolean;
        next_page?: string | null;
      };
      for (const ev of resp.data) {
        if (ev.id) lastId = ev.id;
        // Canvas replay scans the FULL history every time (cheap —
        // just a string ref) so it survives /reset + the scannedUpTo
        // watermark skip.
        for (const use of extractToolUses(ev)) {
          if (use.toolName === TOOL_NAMES.canvas) {
            lastCanvasHtml = String(use.input.html ?? "");
          }
        }
        if (skipping) {
          if (ev.id === this.scannedUpTo) skipping = false;
          continue;
        }
        const t = ev.type;
        if (t === "status_closed" || t === "status_archived") terminal = true;
        if (t === "status_running") sawRunning = true;
        for (const use of extractToolUses(ev)) {
          if (isBrowserTool(use.toolName) && !handled.has(use.toolUseId)) {
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

    // If we never found the watermark (e.g. cursor skipped past it),
    // we processed nothing — reset and the next tick does a full scan.
    if (skipping) this.scannedUpTo = null;
    else if (lastId) this.scannedUpTo = lastId;

    for (const use of dangling.values()) {
      await this.handleToolUse(sessionId, use);
    }
    if (
      lastCanvasHtml !== null &&
      !(await this.ctx.storage.get<string>(CANVAS_KEY))
    ) {
      await this.ctx.storage.put(CANVAS_KEY, lastCanvasHtml);
    }
    const persist = cursor ?? lastId;
    if (persist) await this.ctx.storage.put(CURSOR_KEY, persist);

    return { terminal, sawRunning };
  }

  /**
   * Poll drainDangling every POLL_MS until drain sees status_closed/
   * archived, or no activity for IDLE_LINGER_MS. No separate sessionStatus
   * call — drain already reads every event, so it surfaces the last status
   * transition for free (saves one tunnel round-trip per tick).
   */
  private async listen(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const POLL_MS = 500;
    let lastActivity = Date.now();
    let prevHandled = (
      await this.ctx.storage.list({ prefix: HANDLED_PREFIX })
    ).size;

    while (!signal.aborted) {
      const { terminal, sawRunning } = await this.drainDangling(sessionId);
      if (terminal) break;

      const nowHandled = (
        await this.ctx.storage.list({ prefix: HANDLED_PREFIX })
      ).size;
      if (nowHandled > prevHandled || sawRunning) {
        lastActivity = Date.now();
        prevHandled = nowHandled;
      } else if (Date.now() - lastActivity > IDLE_LINGER_MS) {
        break;
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  private async handleToolUse(
    sessionId: string,
    use: ToolUse,
  ): Promise<void> {
    const doneKey = HANDLED_PREFIX + use.toolUseId;
    if (await this.ctx.storage.get<boolean>(doneKey)) return;

    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await this.runTool(
        use.toolName as BrowserToolName,
        use.input,
      );
    } catch (e) {
      const msg =
        e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      console.error("[tool] crashed", use.toolName, msg);
      result = { isError: true, content: [{ type: "text", text: msg }] };
    }
    const tTool = Date.now() - t0;

    await this.anthropic.beta.sessions.events.send(sessionId, {
      events: [
        {
          type: "tool_result",
          tool_use_id: use.toolUseId,
          is_error: result.isError,
          content: result.content,
        } as never,
      ],
    });

    await this.ctx.storage.put(doneKey, true);
    this.lastTool = use.toolName;
    console.log("[tool]", use.toolName, {
      toolMs: tTool,
      sendMs: Date.now() - t0 - tTool,
      totalMs: Date.now() - t0,
      error: result.isError,
    });

    // Guaranteed per-tool viewport update. Individual tool handlers may
    // have already called captureAsync (after nav/click/etc) — the
    // fire-and-forget chain dedups close-together captures. For tools
    // that don't touch the page (browser_note) this is the only trigger.
    if (this.pageLive()) this.captureAsync(this.page!);
    void this.broadcastState();
  }

  // ---------------------------------------------------------------------------
  // Tool dispatch
  // ---------------------------------------------------------------------------

  private async runTool(
    name: BrowserToolName,
    input: Record<string, unknown>,
  ): Promise<ToolResult> {
    const page = await this.ensurePage();

    switch (name) {
      case TOOL_NAMES.goto: {
        const url = str(input.url);
        if (!/^https?:\/\//.test(url)) {
          return errText(`refuse: URL must be http/https, got "${url}"`);
        }
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT,
        });
        this.captureAsync(page);
        return okText(
          `navigated → ${page.url()} — "${await page.title()}"`,
        );
      }

      case TOOL_NAMES.read: {
        const r = (await page.evaluate(EXTRACT_SCRIPT)) as ExtractResult;
        this.indexMap = r.map;
        await this.ctx.storage.put(MAP_KEY, r.map);
        this.captureAsync(page);
        return okText(r.text);
      }

      case TOOL_NAMES.click: {
        const sel = await this.resolve(str(input.target));
        if (!sel) return errText(`no element for target "${input.target}"`);
        if (/\boption\b/i.test(sel)) {
          return errText(
            `Can't click <option> elements — use browser_select on the ` +
              `parent <select> with the option's value attribute.`,
          );
        }
        const el = await page.$(sel);
        if (!el) {
          return errText(
            `selector "${sel}" matches nothing on ${page.url()}. ` +
              `Call browser_read first and use a [N] index.`,
          );
        }
        const before = page.url();
        const beforeLen = await page.evaluate(
          "document.body ? document.body.innerText.length : 0",
        );
        // Probe the element so we can diagnose why a click didn't
        // navigate (form validation, target=_blank, hidden input, etc).
        // NB: must be an arrow FUNCTION, not a string — el.evaluate('str')
        // evaluates the string but never passes the element (puppeteer
        // asserts 'Cannot evaluate a string with arguments'). Arrow fns
        // dodge esbuild's __name() keepNames helper that broke EXTRACT_SCRIPT.
        const probe = await el
          .evaluate((e) => {
            const inp = e as HTMLInputElement;
            const form = inp.form;
            return {
              type: inp.type || "",
              tag: e.tagName || "",
              isSubmit:
                !!form &&
                (inp.type === "submit" ||
                  (e.tagName === "BUTTON" &&
                    (!inp.type || inp.type === "submit"))),
              formTarget: form?.target || "",
              formAction: form?.getAttribute("action") || "",
              formValid: form?.checkValidity() ?? true,
              visible:
                (e as HTMLElement).offsetWidth > 0 &&
                (e as HTMLElement).offsetHeight > 0,
            };
          })
          .catch(() => ({
            type: "",
            tag: "",
            isSubmit: false,
            formTarget: "",
            formAction: "",
            formValid: true,
            visible: true,
          }));
        // Force target=_self so submissions don't spawn untracked tabs,
        // and disable validation so required-but-empty fields don't
        // silently block the submit.
        if (probe.isSubmit) {
          await el
            .evaluate((e) => {
              const f = (e as HTMLInputElement).form!;
              f.target = "_self";
              f.noValidate = true;
            })
            .catch(() => {});
        }
        const doClick = probe.isSubmit
          ? () =>
              el
                .evaluate((e) =>
                  (e as HTMLInputElement).form!.requestSubmit(
                    e as HTMLElement,
                  ),
                )
                .catch(() => el.click())
          : () => el.click();
        try {
          await settleAround(page, doClick);
        } catch (e) {
          // "Execution context was destroyed" = navigation happened
          // mid-evaluate. That's success, not failure.
          if (String(e).includes("context was destroyed")) {
            await page
              .waitForNavigation({
                waitUntil: "domcontentloaded",
                timeout: 5000,
              })
              .catch(() => {});
            this.captureAsync(page);
            return okText(
              `clicked ${sel} → ${page.url()} "${await page.title()}"`,
            );
          }
          throw e;
        }
        this.captureAsync(page);
        const after = page.url();
        if (after !== before) {
          return okText(`clicked ${sel} → ${after} "${await page.title()}"`);
        }
        // Same URL — could still be a successful same-page POST
        // (jewishgen's jgform.php, any search-results-on-same-url form).
        // Report content delta so the agent knows something happened.
        const afterLen = await page
          .evaluate("document.body ? document.body.innerText.length : 0")
          .catch(() => beforeLen);
        const delta = Number(afterLen) - Number(beforeLen);
        if (delta !== 0) {
          return okText(
            `clicked ${sel} — same URL, content changed (${delta > 0 ? "+" : ""}${delta} chars). ` +
              `Call browser_read to see the new content.`,
          );
        }
        // Nothing happened — surface why.
        const diag: string[] = [];
        if (!probe.visible) diag.push("element was HIDDEN");
        if (probe.isSubmit) {
          diag.push(`form action="${probe.formAction}"`);
          if (probe.formTarget && probe.formTarget !== "_self")
            diag.push(`target="${probe.formTarget}" (was forced to _self)`);
          if (!probe.formValid)
            diag.push("form had invalid fields (noValidate forced)");
        } else {
          const tag = (probe?.tag || "element").toLowerCase();
          diag.push(
            `<${tag}${probe?.type ? ` type=${probe.type}` : ""}> is not a submit — ` +
              `if you meant to submit a form, click its submit button`,
          );
        }
        return okText(
          `clicked ${sel} — no effect. ${diag.join("; ") || "no diagnostic"}. ` +
            `Try browser_read to refresh [N] indices.`,
        );
      }

      case TOOL_NAMES.type: {
        const sel = await this.resolve(str(input.target));
        if (!sel) return errText(`no element for target "${input.target}"`);
        const el = await page.$(sel);
        if (!el) {
          return errText(
            `selector "${sel}" matches nothing on ${page.url()}. ` +
              `Call browser_read first and use a [N] index.`,
          );
        }
        const text = str(input.text);
        await el.click({ clickCount: 3 }); // select-all then overwrite
        await el.type(text, { delay: 5 });
        if (input.submit) {
          await settleAround(page, () => page.keyboard.press("Enter"));
        }
        this.captureAsync(page);
        return okText(
          `typed into ${sel} (${text.length} chars)` +
            (input.submit ? ` + Enter → ${page.url()}` : ""),
        );
      }

      case TOOL_NAMES.select: {
        const sel = await this.resolve(str(input.target));
        if (!sel) return errText(`no element for target "${input.target}"`);
        const el = await page.$(sel);
        if (!el) {
          return errText(
            `selector "${sel}" matches nothing on ${page.url()}.`,
          );
        }
        const value = str(input.value);
        const chosen = await page.select(sel, value);
        if (chosen.length === 0) {
          const opts = await page.evaluate(
            `Array.from(document.querySelector(${JSON.stringify(sel)})?.options||[]).map(o=>o.value+' ('+o.text+')').slice(0,20)`,
          );
          return errText(
            `value "${value}" not in <select> ${sel}. ` +
              `Available: ${JSON.stringify(opts)}`,
          );
        }
        this.captureAsync(page);
        return okText(`selected ${sel} = "${chosen[0]}"`);
      }

      case TOOL_NAMES.scroll: {
        const dy = Number(input.dy) || 800;
        await page.evaluate(`window.scrollBy(0, ${dy})`);
        this.captureAsync(page);
        return okText(`scrolled ${dy}px`);
      }

      case TOOL_NAMES.back: {
        await page.goBack({
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT,
        });
        this.captureAsync(page);
        return okText(`back → ${page.url()}`);
      }

      case TOOL_NAMES.screenshot: {
        const buf = await page.screenshot({
          type: "jpeg",
          quality: 70,
        });
        const b64 = arrayBufferToBase64(buf);
        await this.ctx.storage.put(SHOT_KEY, toArrayBuffer(buf));
        void this.broadcast("frame", "");
        return {
          isError: false,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: b64 },
            },
            {
              type: "text",
              text: `viewport at ${page.url()} — "${await page.title()}"`,
            },
          ],
        };
      }

      case TOOL_NAMES.canvas: {
        const html = str(input.html).slice(0, 8000);
        await this.ctx.storage.put(CANVAS_KEY, html);
        return okText(
          `canvas updated (${html.length}b) — visible in /viewport`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Browser management
  // ---------------------------------------------------------------------------

  private async ensurePage(): Promise<Page> {
    if (this.pageLive()) return this.page!;

    const t0 = Date.now();
    const width = Number(this.env.VIEWPORT_WIDTH) || 1280;
    const height = Number(this.env.VIEWPORT_HEIGHT) || 800;

    if (!this.browser || !this.browser.isConnected()) {
      // Try to reattach to an idle Browser Rendering session first so
      // cookies/tabs survive DO evictions.
      const pool = await puppeteer.sessions(this.env.BROWSER);
      const idle = pool.find((s) => !s.connectionId);
      if (idle) {
        this.browser = await puppeteer.connect(
          this.env.BROWSER,
          idle.sessionId,
        );
        console.log("[browser] reattached", {
          ms: Date.now() - t0,
          session: idle.sessionId,
        });
      } else {
        this.browser = await puppeteer.launch(this.env.BROWSER, {
          keep_alive: 600_000,
        });
        console.log("[browser] launched", { ms: Date.now() - t0 });
      }
    }

    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    await this.page.setViewport({ width, height });

    // Restore snapshot if we're cold-starting.
    const snap = await this.ctx.storage.get<BrowserSnapshot>(SNAPSHOT_KEY);
    if (snap && (!this.page.url() || this.page.url() === "about:blank")) {
      if (snap.cookies.length > 0) {
        await this.page.setCookie(
          ...(snap.cookies as Parameters<Page["setCookie"]>),
        );
      }
      await this.page.goto(snap.url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
    }

    const map = await this.ctx.storage.get<Record<string, string>>(MAP_KEY);
    if (map) this.indexMap = map;

    return this.page;
  }

  private async snapshot(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    try {
      const url = this.page.url();
      if (!url || url === "about:blank") return;
      const cookies = await this.page.cookies();
      const localStorage = (await this.page.evaluate(`(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k) || '';
        }
        return out;
      })()`)) as Record<string, string>;
      await this.ctx.storage.put<BrowserSnapshot>(SNAPSHOT_KEY, {
        url,
        cookies: cookies as unknown[],
        localStorage,
        takenAt: Date.now(),
      });
    } catch (e) {
      console.warn("[browseruse] snapshot failed", e);
    }
  }

  private async closeBrowser(): Promise<void> {
    this.closeTimer = null;
    try {
      if (this.page && !this.page.isClosed()) await this.page.close();
    } catch {}
    try {
      if (this.browser?.isConnected()) await this.browser.close();
    } catch {}
    this.page = null;
    this.browser = null;
  }

  /**
   * Fire-and-forget screenshot for the /viewport poller. The tool_result
   * doesn't wait on this — it ships immediately and the poller picks up
   * the frame on its next tick. Chained on `capturing` so back-to-back
   * tool calls don't interleave screenshots out of order.
   */
  private capturing: Promise<void> = Promise.resolve();
  private captureAsync(page: Page): void {
    this.lastUrl = page.url();
    this.capturing = this.capturing
      .then(async () => {
        if (!this.pageLive()) return;
        const buf = await page.screenshot({ type: "jpeg", quality: 50 });
        await this.ctx.storage.put(SHOT_KEY, toArrayBuffer(buf));
        await this.broadcast("frame", "");
      })
      .catch((e) => console.warn("[capture] failed", e));
    this.ctx.waitUntil(this.capturing);
  }

  /** Resolve "[N]" → selector using the last browser_read map, or pass through. */
  /**
   * Resolve a target string to a CSS selector. Accepts:
   *   - [N]          index into the last browser_read map
   *   - a CSS selector (contains # . : [ > or starts with a tag)
   *   - plain text   → XPath text-contains match, returned as xpath/…
   * Returns null only for unknown [N] indices; text and selectors fall
   * through to page.$() which reports "matches nothing" cleanly.
   */
  private async resolve(target: string): Promise<string | null> {
    // strip wrapping quotes the model sometimes adds
    const t = target.replace(/^["']|["']$/g, "").trim();

    const m = t.match(/^\[(\d+)\]$/);
    if (m) {
      if (Object.keys(this.indexMap).length === 0) {
        const saved =
          await this.ctx.storage.get<Record<string, string>>(MAP_KEY);
        if (saved) this.indexMap = saved;
      }
      return this.indexMap[t] ?? null;
    }

    // Looks like a CSS selector — pass through.
    if (/[#.:>\[]/.test(t) || /^[a-z]+$/i.test(t.split(/\s/)[0])) {
      return t;
    }

    // Plain text → xpath text match. Puppeteer's page.$/click accept
    // xpath/… prefixed strings.
    const xp = t.replace(/"/g, '\\"');
    return (
      `xpath/(//button[contains(normalize-space(.),"${xp}")]` +
      `|//a[contains(normalize-space(.),"${xp}")]` +
      `|//input[@type="submit" and contains(@value,"${xp}")]` +
      `|//*[@role="button" and contains(normalize-space(.),"${xp}")])[1]`
    );
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type ResultBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

type ToolResult = { isError: boolean; content: ResultBlock[] };

function okText(text: string): ToolResult {
  return { isError: false, content: [{ type: "text", text }] };
}
function errText(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function toArrayBuffer(buf: Uint8Array | Buffer): ArrayBuffer {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return u.buffer.slice(
    u.byteOffset,
    u.byteOffset + u.byteLength,
  ) as ArrayBuffer;
}

function arrayBufferToBase64(buf: Uint8Array | Buffer): string {
  // nodejs_compat gives us Buffer — use the native path instead of a
  // char-by-char String.fromCharCode loop (which is O(n) allocations
  // and dominates wall-clock on ~100KB jpegs).
  return Buffer.from(buf).toString("base64");
}

/**
 * Wrap a click/submit interaction so we can distinguish "navigated,
 * just slowly" from "didn't navigate". Arms the navigation wait BEFORE
 * firing the interaction (so we don't miss a fast frame event), then:
 *  - if nav completes within 5s → done
 *  - if nav never starts, the networkidle race returns in ≤1s
 * Previous flat 1.5s cap was misreporting jewishgen's 2-4s form POSTs
 * as "(no navigation)".
 */
async function settleAround(
  page: Page,
  interact: () => Promise<void>,
): Promise<void> {
  const nav = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const idle = page
    .waitForNetworkIdle({ idleTime: 300, timeout: 1000 })
    .then(() => false)
    .catch(() => false);

  await interact();
  // Whichever resolves first wins; if idle wins (no nav in 1s), we still
  // give nav a beat in case the POST is just slow to dispatch.
  const wasIdle = await Promise.race([nav, idle]);
  if (!wasIdle) {
    await Promise.race([
      nav,
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
}

function sseEvent(name: string, data: string): string {
  const body =
    data === ""
      ? "data:\n"
      : data
          .split("\n")
          .map((l) => `data: ${l}`)
          .join("\n") + "\n";
  return `event: ${name}\n${body}\n`;
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
