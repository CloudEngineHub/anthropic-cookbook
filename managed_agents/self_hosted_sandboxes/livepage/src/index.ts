import { LivePage } from "./page";
import { PAGE_TOOLS } from "./tools";
import type { Env, WebhookPayload } from "./types";

export { LivePage };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    switch (url.pathname) {
      case "/webhook":
        return handleWebhook(req, env);
      case "/tools":
        return json(PAGE_TOOLS);
      case "/page":
        return handlePage(url, env);
      case "/watch":
        return handleWatch(url, env);
      case "/state":
        return handleState(url, env);
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

  const stub = getPage(env, sessionId);

  switch (evType) {
    case "session.created":
    case "session.running":
    case "session.requires_action":
      await stub.wake(sessionId);
      break;
    case "session.idled":
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

/** Serves the live HTML + an SSE client that repaints on every edit. */
async function handlePage(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  const html = await getPage(env, sessionId).html();
  // Wrap the document in an iframe'd viewer so the SSE client doesn't
  // fight the agent's HTML (the agent owns the inner document; we own
  // the frame around it).
  const viewer = `<!doctype html>
<html><head><meta charset=utf-8><title>livepage — ${escapeHtml(sessionId)}</title>
<style>
  body{margin:0;display:grid;grid-template-rows:auto 1fr;height:100vh;font:13px system-ui}
  #bar{padding:.5rem 1rem;border-bottom:1px solid #ddd;display:flex;gap:1rem;align-items:center;background:#f5f5f4}
  #bar code{font-size:11px;color:#666}
  #dot{width:8px;height:8px;border-radius:50%;background:#999}
  #dot.live{background:#788c5d}
  iframe{border:0;width:100%;height:100%}
</style></head><body>
<div id=bar>
  <span id=dot></span><strong>livepage</strong>
  <code>${escapeHtml(sessionId)}</code>
  <span id=edits style="margin-left:auto;color:#999">—</span>
</div>
<iframe id=frame srcdoc="${escapeHtml(html)}"></iframe>
<script>
  const dot = document.getElementById('dot');
  const frame = document.getElementById('frame');
  const edits = document.getElementById('edits');
  let n = 0;
  const es = new EventSource('/watch?session_id=${encodeURIComponent(sessionId)}');
  es.addEventListener('html', (e) => {
    frame.srcdoc = e.data;
    edits.textContent = (++n) + ' edit' + (n===1?'':'s');
    dot.classList.add('live');
    setTimeout(() => dot.classList.remove('live'), 400);
  });
  es.onerror = () => dot.style.background = '#d44';
</script>
</body></html>`;
  return new Response(viewer, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleWatch(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  // Streams can't cross DO RPC; route via fetch instead.
  return getPage(env, sessionId).fetch(
    new Request("https://do/watch"),
  );
}

async function handleState(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  return json(await getPage(env, sessionId).dump());
}

async function handleReset(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  await getPage(env, sessionId).reset();
  return json({ reset: sessionId });
}

// -----------------------------------------------------------------------------

function getPage(env: Env, sessionId: string): DurableObjectStub<LivePage> {
  const id = env.PAGE.idFromName(sessionId);
  return env.PAGE.get(id) as DurableObjectStub<LivePage>;
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

/**
 * Anthropic signs webhooks with header `X-Webhook-Signature`:
 *   v1,<unix-ts>,<hex hmac-sha256(secret, <ts>.<body>)>
 */
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
