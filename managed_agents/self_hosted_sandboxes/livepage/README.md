# livepage

A Cloudflare Worker that turns an Agent-API session into a live-edited
webpage. The agent's custom tools mutate an HTML document held in a
Durable Object; `/page?session_id=…` serves that document with SSE
auto-refresh so every watcher sees every edit in real time.

## The demo

Two windows, side by side:

- **left** — sessions-ui, the conversation
- **right** — `https://livepage.<you>.workers.dev/page?session_id=<sess>`

You type *"make the headline say 'tools that outlive the tab'"* — the
right window rewrites its `<h1>`. You type *"add a pricing section,
three tiers"* — a table materialises. The URL is real; send it to
someone else and they see the same document, updating as the agent
works.

The demo's payoff isn't a trick: the tool state lives server-side,
addressed by session id, so any client watching (or none) sees one
canonical document.

## Tools

| name | input | effect |
|---|---|---|
| `page_get` | — | return current HTML (so the agent knows what selectors exist) |
| `page_set_html` | `{selector, html}` | replace innerHTML of first match |
| `page_add_block` | `{anchor, position, html}` | insert relative to anchor (`before`/`after`/`append`/`prepend`) |
| `page_remove` | `{selector}` | delete first match |
| `page_set_style` | `{css, id?}` | append/replace a `<style>` block |
| `page_set_attr` | `{selector, name, value}` | set a single attribute |

## Endpoints

| method | path | purpose |
|---|---|---|
| POST | `/webhook` | Anthropic webhook target — wakes the DO on `session.running` |
| GET | `/tools` | custom-tool JSON (sessions-ui fetches this) |
| GET | `/page?session_id=…` | viewer with live iframe + SSE client |
| GET | `/watch?session_id=…` | SSE stream of full-HTML events |
| GET | `/state?session_id=…` | DO introspection |
| GET | `/reset?session_id=…` | wipe the document back to scaffold |

## Deploy

```bash
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Register a webhook endpoint pointing at `/webhook` with
`enabled_events: ["session.running","session.idled","session.archived"]`
— same pattern as `cloudrepl/`.

In sessions-ui's **Cloud REPL** section, paste the worker URL and
Connect — it'll discover the six `page_*` tools.

## System prompt hint

```
You are live-editing a real web page via page_* tools. Always page_get
first so you know the current DOM. Give every element you add an id.
Narrate briefly what you changed after each tool call.
```

## Scaffold

The document starts as a minimal
`<header id="hero"><h1>Untitled</h1></header><main id="content"/><footer id="footer"/>`
with a small base stylesheet (Anthropic clay `#d97757` as the accent).
Everything the agent adds is persisted as a stored edit + the rendered
HTML snapshot, so cold starts rehydrate instantly.
