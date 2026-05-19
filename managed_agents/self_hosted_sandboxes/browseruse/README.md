# browseruse

Agent drives a headless Chromium via Cloudflare Browser Rendering.
One Durable Object per session holds the puppeteer page; `/viewport`
polls the latest screenshot so any watcher sees what the agent sees.

## The demo

**Left:** conversation. **Right:** `browseruse.…workers.dev/viewport?session_id=<sess>`.

> *"go to hacker news and find the top Show HN post"*

Right pane loads news.ycombinator.com. Agent calls `browser_read`,
picks the `[N]` of the filter link, calls `browser_click([N])` —
screenshot updates.

> *"open the comments, what are people saying?"*

Agent clicks through. Right pane shows the discussion. Agent
summarises back in the chat.

The browser tab, its cookies, and its localStorage live in the
worker's Durable Object — snapshotted on session idle, restored on
wake. Nobody's laptop is running Chromium.

## Tools

| name | input | effect |
|---|---|---|
| `browser_goto` | `{url}` | navigate, wait for domcontentloaded |
| `browser_read` | — | numbered extraction of visible text + interactive elements |
| `browser_click` | `{target}` | click `[N]` index or CSS selector |
| `browser_type` | `{target, text, submit?}` | focus + type, optional Enter |
| `browser_scroll` | `{dy}` | scrollBy |
| `browser_back` | — | history back |
| `browser_screenshot` | — | return viewport as image block to the agent |

The `[N]` indices come from `browser_read` and persist in DO storage
so click/type can reference them across agent turns.

## Endpoints

| method | path | purpose |
|---|---|---|
| POST | `/webhook` | Anthropic webhook target — wakes the DO |
| GET | `/tools` | custom-tool JSON (sessions-ui fetches this) |
| GET | `/viewport?session_id=…` | HTML viewer that polls /screenshot.jpg |
| GET | `/screenshot.jpg?session_id=…` | latest viewport capture |
| GET | `/state?session_id=…` | DO introspection |
| GET | `/reset?session_id=…` | close browser + wipe storage |

## Deploy

Requires a Workers Paid account (Browser Rendering is paid-only).

```bash
npm install
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Register a webhook endpoint pointing at `/webhook` — same pattern as
`cloudrepl/` and `livepage/`. All three can coexist on the same org.

## System-prompt hint

```
You have a real browser via browser_* tools. Call browser_goto first,
then browser_read to see what's clickable (use the [N] indices as
targets). Call browser_read again after every navigation. Use
browser_screenshot only when the text extraction isn't enough.
```

## Resource notes

- Puppeteer session is held open while the SSE stream is active, kept
  alive 60s after idle so back-to-back turns reuse the same tab.
- On wake the DO tries `puppeteer.sessions()` to reattach to an idle
  Browser Rendering session before launching a fresh one — lets
  cookies and the page survive DO evictions.
- Every tool call captures a jpeg@60 screenshot to DO storage for the
  viewport poller; `browser_screenshot` additionally returns a
  higher-quality jpeg@70 directly to the agent as an image block.
