# Self-Hosted Sandboxes

Reference implementations for running Claude Managed Agents sessions against
**self-hosted execution sandboxes**. Each variant implements the same contract
on a different compute provider:

1. Receive the `session.status_run_started` webhook (verified with
   `client.beta.webhooks.unwrap()`).
2. Drain the environment work queue so a single delivery recovers any earlier
   missed items.
3. Per work item, launch a per-session sandbox that runs the SDK/CLI tool
   runner (`bash`/`read`/`write`/`edit`/`glob`/`grep`), heartbeats the lease,
   and posts `tool_result`s back to the session.

No org API key reaches the runner — the sandbox authenticates with the
**environment key**, the single credential for both the control plane and the
per-session calls.

| Variant | Compute | Runner |
|---|---|---|
| [`self_hosted_sandbox-docker/`](self_hosted_sandbox-docker/) | Plain Docker on a host you control | `ant beta:worker run` in a per-session container |
| [`self_hosted_sandbox-cf/`](self_hosted_sandbox-cf/) | Cloudflare Containers | `ant beta:worker run` in a per-session Cloudflare Container |
| [`self_hosted_sandbox-cf-worker/`](self_hosted_sandbox-cf-worker/) | Cloudflare Workers (no container) | TS `SessionToolRunner` in a Durable Object with an in-isolate fake filesystem |
| [`self_hosted_sandbox-modal/`](self_hosted_sandbox-modal/) | [Modal](https://modal.com) | Python `sandbox_runner.py` in a Modal Sandbox with a per-session Volume |
| [`self_hosted_sandbox-daytona/`](self_hosted_sandbox-daytona/) | [Daytona](https://www.daytona.io/) | Same `sandbox_runner.py` uploaded to a Daytona sandbox |
| [`self_hosted_sandbox-vercel/`](self_hosted_sandbox-vercel/) | Vercel Functions + Sandbox | Node `runner.mjs` in a Vercel Sandbox |

## Getting started

See [`docs/usage-guide.md`](docs/usage-guide.md) for the full flow: creating a
self-hosted environment, registering the webhook, and wiring up the
environment key. Each variant's `README.md` covers its provider-specific
deploy steps.

See [`docs/upgrade-guide.md`](docs/upgrade-guide.md) for migrating between SDK
versions.
