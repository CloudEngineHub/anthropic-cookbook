import { BrowserSession } from "./browser";
import { BROWSER_TOOLS } from "./tools";
import type { Env, WebhookPayload } from "./types";

export { BrowserSession };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/webhook":
        return handleWebhook(req, env);
      case "/tools":
        return json(BROWSER_TOOLS);
      case "/viewport":
        return handleViewport(url, env);
      case "/screenshot.jpg":
        return handleScreenshot(url, env);
      case "/watch":
        return handleWatch(url, env);
      case "/state":
        return handleState(url, env);
      case "/wake":
        return handleWake(url, env);
      case "/reset":
        return handleReset(url, env);
      case "/health":
        return new Response("ok");
      default:
        return new Response("not found", { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;

// -----------------------------------------------------------------------------

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  const raw = await req.text();
  if (!(await verifySignature(req, raw, env.WEBHOOK_SECRET))) {
    return new Response("bad signature", { status: 401 });
  }
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const evType = payload.data?.type;
  const sessionId = payload.data?.id;
  if (!sessionId || !evType) {
    return new Response("no session id", { status: 400 });
  }

  const lag = Date.now() - Date.parse(payload.timestamp);
  console.log("[webhook]", evType, { sessionId, lagMs: lag });

  const stub = getSession(env, sessionId);
  switch (evType) {
    case "session.created":
    case "session.running":
    case "session.requires_action":
    case "session.idled":
      // idled is the load-bearing event on staging: when the agent
      // blocks on a custom tool_use, the session transitions to idle.
      // That's when we need to wake, drain the dangling tool_use, and
      // POST the result. (session.running isn't emitted on staging —
      // that was a local proto extension.)
      await stub.wake(sessionId);
      break;
    case "session.archived":
    case "session.deleted":
      await stub.terminate();
      break;
    default:
      break;
  }
  return new Response("ok");
}

/** HTML viewer — SSE-pushed + poll-fallback view of the agent's viewport. */
async function handleViewport(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  const w = Number(env.VIEWPORT_WIDTH) || 1280;
  const h = Number(env.VIEWPORT_HEIGHT) || 800;
  const sid = encodeURIComponent(sessionId);
  const html = `<!doctype html>
<html><head><meta charset=utf-8><title>browseruse — ${escapeHtml(sessionId)}</title>
<style>
  body{margin:0;display:grid;grid-template-rows:auto auto 1fr;height:100vh;font:13px system-ui;background:#1a1a1a;color:#ddd}
  #bar{padding:.5rem 1rem;display:flex;gap:1rem;align-items:center;background:#2a2a2a;border-bottom:1px solid #444}
  #bar code{font-size:11px;color:#888}
  #conn{display:inline-flex;align-items:center;gap:.4rem;padding:.15rem .5rem;border-radius:999px;font-size:11px;font-weight:500;background:#3a3a3a;color:#888}
  #conn.on{background:#788c5d22;color:#9cb87a}
  #conn.on::before{content:"";width:6px;height:6px;border-radius:50%;background:#788c5d;animation:pulse 2s ease-in-out infinite}
  #conn.off::before{content:"";width:6px;height:6px;border-radius:50%;background:#666}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #dot{width:8px;height:8px;border-radius:50%;background:#555;transition:background .1s}
  #dot.live{background:#d97757}
  #url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;font-size:11px;color:#aaa}
  #stats{font-size:10px;color:#666}
  #last{font-size:10px;font-family:monospace;padding:.1rem .4rem;border-radius:3px;background:#444;color:#bbb}
  #last:empty{display:none}
  #canvas{border:none;width:100%;background:#262626;border-bottom:1px solid #444;display:none}
  #canvas.show{display:block}
  #wrap{overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:1rem}
  #shot{max-width:100%;height:auto;box-shadow:0 4px 24px rgba(0,0,0,.5);border-radius:4px;aspect-ratio:${w}/${h};background:#000}
</style></head><body>
<div id=bar>
  <span id=conn class=off>connecting…</span>
  <strong>browseruse</strong>
  <span id=dot></span>
  <span id=last></span>
  <span id=url>—</span>
  <span id=stats></span>
  <code>${escapeHtml(sessionId)}</code>
</div>
<iframe id=canvas sandbox="allow-same-origin"></iframe>
<div id=wrap><img id=shot alt="viewport" src="/screenshot.jpg?session_id=${sid}&_=0"></div>
<script>
  const conn = document.getElementById('conn');
  const dot = document.getElementById('dot');
  const shot = document.getElementById('shot');
  const urlEl = document.getElementById('url');
  const stats = document.getElementById('stats');
  const last = document.getElementById('last');
  const canvas = document.getElementById('canvas');
  let canvasHash = '';

  async function fetchShot() {
    const r = await fetch('/screenshot.jpg?session_id=${sid}&_=' + Date.now(),
                          { cache: 'no-store' });
    if (!r.ok) return;
    const blob = await r.blob();
    const prev = shot.src;
    shot.src = URL.createObjectURL(blob);
    if (prev.startsWith('blob:')) URL.revokeObjectURL(prev);
    dot.classList.add('live');
    setTimeout(() => dot.classList.remove('live'), 200);
  }

  function renderCanvas(html) {
    // Skip re-render if unchanged — srcdoc rewrite flickers the iframe.
    if (html === canvasHash) return;
    canvasHash = html;
    if (!html) { canvas.classList.remove('show'); return; }
    canvas.srcdoc = '<!doctype html><meta charset=utf-8>' +
      '<style>body{margin:0;padding:.75rem 1rem;background:#262626;' +
      'color:#ddd;font:12px system-ui;line-height:1.5}' +
      'svg{max-width:100%;height:auto}</style>' + html;
    canvas.classList.add('show');
    // auto-size to content once it renders
    canvas.onload = () => {
      const h = canvas.contentDocument?.body?.scrollHeight || 0;
      canvas.style.height = Math.min(h + 4, window.innerHeight * 0.4) + 'px';
    };
  }

  function applyState(s) {
    conn.textContent = s.listening ? 'listening' : 'sleeping';
    conn.className   = s.listening ? 'on' : 'off';
    urlEl.textContent = s.url || '—';
    last.textContent  = s.lastTool || '';
    stats.textContent = s.handled + ' tool calls · browser ' +
                        (s.hasBrowser ? 'open' : 'closed');
    renderCanvas(s.canvas || '');
  }

  async function pollState() {
    try {
      const r = await fetch('/state?session_id=${sid}', { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      applyState(s);
      // Keep the listener alive while the viewport is open — the local
      // webhook pipeline is flaky, so this is the reliable wake source.
      if (!s.listening) {
        fetch('/wake?session_id=${sid}').catch(() => {});
      }
    } catch {}
  }

  // SSE push — primary update path.
  const es = new EventSource('/watch?session_id=${sid}');
  es.addEventListener('frame', fetchShot);
  es.addEventListener('state', e => applyState(JSON.parse(e.data)));
  es.onopen  = () => pollState(); // fetch initial state on (re)connect
  es.onerror = () => { conn.textContent = 'reconnecting…'; conn.className = 'off'; };

  // Poll fallback — catches updates the SSE stream missed (DO eviction,
  // worker redeploy, or a zombie connection that looks open but isn't).
  pollState();
  fetchShot();
  setInterval(pollState, 5_000);
  setInterval(fetchShot, 30_000);
</script>
</body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleScreenshot(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  const buf = await getSession(env, sessionId).screenshot();
  if (!buf) {
    return new Response("no screenshot yet", { status: 404 });
  }
  return new Response(buf, {
    headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
  });
}

async function handleWatch(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  // Streams can't cross DO RPC — route via fetch.
  return getSession(env, sessionId).fetch(
    new Request("https://do/watch"),
  );
}

async function handleState(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  return json(await getSession(env, sessionId).dump());
}

async function handleWake(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  await getSession(env, sessionId).wake(sessionId);
  return json({ woke: sessionId });
}

async function handleReset(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  await getSession(env, sessionId).reset();
  return json({ reset: sessionId });
}

// -----------------------------------------------------------------------------

function getSession(
  env: Env,
  sessionId: string,
): DurableObjectStub<BrowserSession> {
  const id = env.SESSION.idFromName(sessionId);
  return env.SESSION.get(id) as DurableObjectStub<BrowserSession>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function verifySignature(
  req: Request,
  body: string,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret) return true;
  const header = req.headers.get("x-webhook-signature");
  if (!header) return false;
  const [ver, ts, expected] = header.split(",");
  if (ver !== "v1" || !ts || !expected) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${ts}.${body}`),
  );
  const got = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (got.length !== expected.length) return false;
  let r = 0;
  for (let i = 0; i < got.length; i++)
    r |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return r === 0;
}
