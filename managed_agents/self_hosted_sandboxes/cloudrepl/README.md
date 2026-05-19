# cloudrepl

A Cloudflare Worker that gives Anthropic Agent-API sessions a persistent
JavaScript REPL, backed by a Durable Object per session.

## How it works

```
┌─────────────────┐  webhook (session.running /  ┌─────────────────────────┐
│ Anthropic API   │──  requires_action)────────▶ │ Worker /webhook         │
│ (staging)       │                              │   │                     │
│                 │◀── SSE stream ───────────────│   ▼                     │
│                 │◀── POST tool_result ─────────│ DurableObject           │
└─────────────────┘    GET events/list           │  ReplSession(sessId)    │
                                                 │   - scope{}  (in-mem)   │
                                                 │   - snip:*   (durable)  │
                                                 │   - done:*   (durable)  │
                                                 │   - cursor   (durable)  │
                                                 └─────────────────────────┘
```

1. The user registers a webhook endpoint pointing at
   `https://<worker>.workers.dev/webhook` with `enabled_events` =
   `session.running`, `session.idled`, `session.archived`.
2. The user creates a session whose `agent.tools` includes the two custom
   tools (`js_repl`, `js_list_symbols`). sessions-ui does this automatically
   when you toggle "Cloud REPL" on the create-session dialog.
3. When the session transitions to `running`, Anthropic POSTs to `/webhook`.
   The Worker routes by session id to a Durable Object.
4. The DO first **drains dangling tool_uses**: it lists events from the
   stored cursor forward, finds any `js_repl`/`js_list_symbols` `tool_use`
   without a matching `tool_result` that it hasn't already handled, executes
   the code, and POSTs a `tool_result` back.
5. The DO then opens an SSE stream and reacts to new `tool_use` events live.
6. On `status_idle` (stream) or `session.idled` (webhook) the DO breaks its
   loop and the worker sleeps.

### Persistence

- `snip:<paddedTs>` → `{names, source, createdAt}`. Replayed in insertion
  order on cold-start to rebuild `scope`.
- `done:<tool_use_id>` → `true`. Idempotency guard so webhook + stream +
  catch-up can all surface the same event without double-POSTing.
- `cursor` → last event id we scanned. Optimisation only — the `done:` set
  is the source of truth for "already replied".

## Deploy

```bash
npm install
npx wrangler secret put ANTHROPIC_API_KEY   # staging key, same as sessions-ui
npx wrangler secret put WEBHOOK_SECRET      # from step 2 below, optional
npx wrangler deploy
```

### Register the webhook

```bash
curl -sS https://api-staging.anthropic.com/v1/webhooks \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: webhooks-2026-01-01" \
  -H "content-type: application/json" \
  -d '{
    "url": "https://cloudrepl.<your-subdomain>.workers.dev/webhook",
    "name": "cloudrepl",
    "enabled_events": [
      "session.running",
      "session.idled",
      "session.archived"
    ]
  }'
```

The response includes a `signing_secret` — put it into the `WEBHOOK_SECRET`
Worker secret if you want signature verification (the worker accepts
unsigned requests when the secret is unset, for local dev).

> **Heads-up**: `session.running` is in the webhook proto enum but the
> transformer (`webhook_transformer.py:_map_session_event_type`) does not yet
> emit it — the `SessionWebhookEvent` proto has no `session_running` oneof
> variant. You'll need to add it to both
> `api-go/proto/anthropic/session_events/v1alpha/webhook.proto` and the match
> arm in `_map_session_event_type` before this fires in practice.

### Point sessions-ui at it

In the **Create Session** dialog, open the **Cloud REPL** section, paste the
worker URL (`https://cloudrepl.<your-subdomain>.workers.dev`), and toggle it
on. sessions-ui will pull `/tools` from the worker and merge the two custom
tool definitions into `agent.tools` at create time.

## Local dev

```bash
npx wrangler dev
# webhook at http://localhost:8787/webhook
# fake a webhook:
curl -X POST localhost:8787/webhook \
  -H 'content-type: application/json' \
  -d '{"type":"event","id":"whe_test","timestamp":"2026-01-01T00:00:00Z",
       "data":{"type":"session.running","id":"sess_01ABC",
               "organization_id":"org_x","workspace_id":"wrkspc_y"}}'
```

## Endpoints

| Method | Path        | Purpose                                         |
|--------|-------------|-------------------------------------------------|
| POST   | `/webhook`  | Anthropic webhook target                        |
| GET    | `/tools`    | Custom-tool JSON (sessions-ui fetches this)     |
| GET    | `/state?session_id=…` | Dump symbols + cursor for a session   |
| GET    | `/health`   | 200 ok                                          |
