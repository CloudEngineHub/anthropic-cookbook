import { ReplSession } from "./repl";
import { REPL_TOOLS } from "./tools";
import type { Env, WebhookPayload } from "./types";

export { ReplSession };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    switch (url.pathname) {
      case "/webhook":
        return handleWebhook(req, env);
      case "/tools":
        return json(REPL_TOOLS);
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

  const stub = getRepl(env, sessionId);

  switch (evType) {
    case "session.running":
      await stub.wake(sessionId);
      break;
    case "session.idled":
    case "session.archived":
    case "session.deleted":
      await stub.sleep();
      break;
    default:
      break;
  }

  return new Response("ok");
}

async function handleState(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  const stub = getRepl(env, sessionId);
  return json(await stub.dump());
}

async function handleReset(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) {
    return new Response("?session_id required", { status: 400 });
  }
  await getRepl(env, sessionId).reset();
  return json({ reset: sessionId });
}

function getRepl(env: Env, sessionId: string): DurableObjectStub<ReplSession> {
  const id = env.REPL.idFromName(sessionId);
  return env.REPL.get(id) as DurableObjectStub<ReplSession>;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Anthropic signs webhooks with header `X-Webhook-Signature`:
 *   v1,<unix-timestamp>,<hex hmac-sha256(secret, <ts>.<body>)>
 * If no secret is configured, accept everything (dev mode).
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

  return timingSafeEqual(got, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
