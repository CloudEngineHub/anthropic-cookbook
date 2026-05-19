# CMA Cloudflare Worker Demos

Three Cloudflare Workers that handle Agent-API custom tools via session
webhook. The agent calls a custom tool, the session blocks and transitions
to `idle`, the webhook wakes the worker, the worker drains the dangling
`tool_use` from `events.list` and POSTs back a `tool_result`.

| Worker | Tools | State |
|---|---|---|
| [`cloudrepl/`](cloudrepl/) | `js_repl`, `js_list_symbols` | QuickJS-WASM scope snippets persisted to DO storage, replayed on cold start |
| [`livepage/`](livepage/) | `page_html`, `page_css`, `page_js`, `page_read` | Current page source in DO storage, live-pushed to viewers via SSE |
| [`browseruse/`](browseruse/) | `browser_goto`/`read`/`click`/`type`/`select`/`scroll`/`back`/`screenshot`/`canvas` | Headless Chromium via Cloudflare Browser Rendering; cookie jar + URL snapshot persisted |

## Deploy flow

The flow is the same for all three. Using `browseruse` as the example:

```bash
cd browseruse
npm install
```

### 1. Deploy the worker

```bash
npm run deploy
# → https://browseruse-<you>.<your-subdomain>.workers.dev
```

`npm run deploy` scopes the worker name to `${SAFEUSER:-$(whoami)}` so
multiple people can deploy without clobbering each other's Durable Object
state. Use `npm run deploy:shared` for the un-scoped name if you
deliberately want a shared instance.

### 2. Set the API key secret

```bash
npx wrangler secret put ANTHROPIC_API_KEY --name browseruse-$(whoami)
# paste your staging key
```

The worker uses this to call `events.list` and POST `tool_result`s back to
the session.

### 3. Register the webhook

```bash
curl -sS https://api-staging.anthropic.com/v1/webhooks \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: webhooks-2026-01-01" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://browseruse-<you>.<your-subdomain>.workers.dev/webhook",
    "name": "browseruse-<you>",
    "enabled_events": [
      "session.created",
      "session.idled",
      "session.requires_action",
      "session.archived"
    ]
  }'
```

The response includes a `signing_secret` — keep it for step 4.

**Why `session.idled`?** When the agent blocks on a custom `tool_use`, the
session transitions to `idle`. That's the load-bearing event — it's when
the worker needs to wake, drain, and reply. `session.requires_action` is
belt-and-braces (fires on permission prompts). `session.created` lets the
worker warm its browser/REPL before the first tool call.

### 4. (Optional) Set the webhook signing secret

```bash
npx wrangler secret put WEBHOOK_SECRET --name browseruse-$(whoami)
# paste the signing_secret from step 3
```

If unset, the worker accepts unsigned requests (fine for demo, not for
anything you'd leave running). The signature header is
`X-Webhook-Signature: v1,<unix-ts>,<hex hmac-sha256(secret, <ts>.<body>)>`.

## Connect from sessions-ui

In the **Create Agent** (or **Edit Agent**) dialog, open **Cloudflare
Worker Tools**, paste the worker URL, click **Connect**. sessions-ui
fetches `GET /tools` from the worker and merges the custom tool defs into
the agent's `tools[]`.

Then create a session from that agent and ask it to e.g. "go to
example.com and tell me what's on the page" (browseruse) or "define a
fibonacci function and compute fib(20)" (cloudrepl).

## Local dev

```bash
npm run dev
# → http://localhost:8787
```

Fake a webhook to kick it:

```bash
curl -X POST localhost:8787/webhook \
  -H 'content-type: application/json' \
  -d '{"type":"event","id":"whe_test","timestamp":"2026-01-01T00:00:00Z",
       "data":{"type":"session.idled","id":"sess_01ABC",
               "organization_id":"org_x","workspace_id":"wrkspc_y"}}'
```

## Endpoints (shared across all three)

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhook` | Anthropic webhook target |
| GET | `/tools` | Custom-tool JSON (sessions-ui fetches this) |
| GET | `/state?session_id=…` | Dump DO state for a session |
| GET | `/wake?session_id=…` | Manually kick the listener (useful after a redeploy — DOs don't auto-migrate) |
| GET | `/reset?session_id=…` | Wipe DO storage for a session |
| GET | `/health` | 200 ok |

browseruse also has `/viewport?session_id=…` (live screenshot viewer) and
`/screenshot.jpg?session_id=…`; livepage has `/page?session_id=…` (the
live-edited page); cloudrepl is endpoint-minimal.

## Durable Object migration note

Deploying a new version does **not** evict existing DO instances — they
keep running old code until Cloudflare rotates them (minutes to hours).
After a redeploy, hit `/wake?session_id=…` on a fresh session to test the
new code; existing sessions may still be on the old version.
