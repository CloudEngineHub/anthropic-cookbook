# Running a self-hosted worker

Set up your self-hosted environment in three steps. These instructions are always available in your environment details.

These instructions are pinned to the released SDK builds: Python `0.102.0`, TypeScript `0.96.0`, `ant` CLI v1.8.0.

## 0. Prerequisites

All public-API calls below require:

```
anthropic-version: 2023-06-01
anthropic-beta: managed-agents-2026-04-01
```

If you're reading this, you were already gated in by us to have access to all the APIs and Console functionality to use self-hosted workers for containers. If that is not the case please reach out to us so we can fix!

### SDKs:

```
# Python SDK
uv pip install https://app.stainless.com/pkg/s/anthropic-python/00209c25418497163e3bc2c5839cf651d24822c3/anthropic-0.102.0-py3-none-any.whl

# TS SDK
npm i https://app.stainless.com/pkg/s/anthropic-typescript/9d2ab62380ef11d23ff45d8dc581659723721b81/dist.tar.gz
```

#### Using ant CLI for worker management

Run this on the machine where you want the worker to run. It installs `ant`, which includes the worker that polls for jobs and executes them locally.

Linux
```
SHA=cc2a5c39fc4b9aa69a43ccfc13c63523a40bf491
ARCH=$(uname -m | sed -e 's/x86_64/amd64_v1/' -e 's/aarch64/arm64_v8.0/')
curl -fsSL "https://app.stainless.com/pkg/s/anthropic-cli/${SHA}/dist.zip" -o /tmp/ant-dist.zip
unzip -oj /tmp/ant-dist.zip "linux_linux_${ARCH}/ant" -d /tmp
sudo install -m 0755 /tmp/ant /usr/local/bin/ant
ant --version
```

## 1. Creating a Self-hosted environment

In Console → Workspace → Environments → New → Self-hosted

Alternatively, create the self-hosted environment in-code:
```
client = anthropic.Anthropic(api_key=API_KEY)

environment = client.beta.environments.create(
    name="self-hosted",
    config={"type": "self_hosted"},
)
```

```
const client = new Anthropic({ apiKey: API_KEY });

const environment = await client.beta.environments.create({
  name: "self-hosted",
  config: { type: "self_hosted" },
});
```

Generate an environment key.
- In Console, open the environment and click Generate environment key.
- Set it as `ANTHROPIC_ENVIRONMENT_KEY` on your runner host.
- This key authenticates the whole worker flow — poll, ack, stop, heartbeat, the session event stream, and skill download — for that one environment. It is the only credential the worker needs.

## 2. Set your environment key

Generate an environment key for this environment in the console. The key authenticates your infrastructure with this environment. Export it on the worker host:

```
export ANTHROPIC_ENVIRONMENT_KEY="sk-ant-oat01-..."
```

## 3. Start the worker

`ant beta:worker poll` runs a built-in loop that claims sessions assigned to this environment, executes tool calls (`bash`, `read`, `write`, `edit`, `glob`, `grep`) in `--workdir`, and posts results back.

```
ant beta:worker poll \
  --environment-id "env_01F9z9WM52grdeXJnpnHZxBk" \
  --workdir "/workspace"
```

Every flag also reads from an environment variable, so a zero-flag invocation works for systemd or compose:

```
ANTHROPIC_ENVIRONMENT_ID=env_01F9z9WM52grdeXJnpnHZxBk \
ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-... \
ant beta:worker poll --workdir /workspace
```

The worker exits cleanly on SIGTERM or SIGINT, draining in-flight tool calls before stopping.

### Spawning your own process per work item

Pass `--on-work <script>` to run an external script for each claimed work item instead of the built-in in-process runner. The script receives the same env vars `ant beta:worker run` reads (`ANTHROPIC_WORK_ID`, `ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_SESSION_ID`, `ANTHROPIC_ENVIRONMENT_KEY`; `ANTHROPIC_BASE_URL` is inherited) plus the raw work JSON on stdin, so the simplest script is:

```
#!/bin/bash
exec docker run --rm \
  -e ANTHROPIC_SESSION_ID -e ANTHROPIC_ENVIRONMENT_KEY \
  -e ANTHROPIC_WORK_ID -e ANTHROPIC_ENVIRONMENT_ID -e ANTHROPIC_BASE_URL \
  your-image ant beta:worker run --workdir /workspace
```

The poller waits for the script to exit before polling again; a non-zero exit is logged but does not stop the poller. SIGTERM to the poller cascades to the script.

### Running the worker as a container entrypoint

If your control plane spawns a fresh container per session rather than one long-lived poller, use `ant beta:worker run` as the entrypoint. It attaches directly to a single session without polling.

```
FROM your-base-image
ARG ANT_SHA=cc2a5c39fc4b9aa69a43ccfc13c63523a40bf491
ARG TARGETARCH
ADD https://app.stainless.com/pkg/s/anthropic-cli/${ANT_SHA}/dist.zip /tmp/ant.zip
RUN DIR=$([ "$TARGETARCH" = "arm64" ] && echo linux_linux_arm64_v8.0 || echo linux_linux_amd64_v1) && \
    unzip -oj /tmp/ant.zip "${DIR}/ant" -d /usr/local/bin && \
    chmod +x /usr/local/bin/ant && rm /tmp/ant.zip
WORKDIR /workspace
ENTRYPOINT ["ant", "beta:worker", "run"]
```

Pass `ANTHROPIC_SESSION_ID`, `ANTHROPIC_ENVIRONMENT_KEY`, `ANTHROPIC_WORK_ID`, and `ANTHROPIC_ENVIRONMENT_ID` as container env vars when launching.

### Alternative: run the worker directly

If you already have the session details (for example your own orchestrator claimed the work and is launching the worker as a subprocess), invoke `ant beta:worker run` directly:

```
ant beta:worker run \
  --session-id "sesn_..." \
  --environment-key "$ANTHROPIC_ENVIRONMENT_KEY" \
  --work-id "work_..." \
  --environment-id "env_..." \
  --workdir "/workspace"
```

Or with env vars only:

```
export ANTHROPIC_SESSION_ID=sesn_...
export ANTHROPIC_ENVIRONMENT_KEY=sk-ant-oat01-...
export ANTHROPIC_WORK_ID=work_...
export ANTHROPIC_ENVIRONMENT_ID=env_...
ant beta:worker run --workdir /workspace
```

`ant beta:worker run` attaches to the session's event stream, executes tool calls, and exits 0 when the session terminates or `--max-idle` elapses after `session.status_idle` with `stop_reason: end_turn` — any other event resets the clock.

## Flags

| Flag | Env var | Default |
| :- | :- | :- |
| `--environment-id` | `ANTHROPIC_ENVIRONMENT_ID` | required |
| `--environment-key` | `ANTHROPIC_ENVIRONMENT_KEY` | required |
| `--on-work` | | in-process runner |
| `--worker-id` | `ANTHROPIC_WORKER_ID` | hostname |
| `--workdir` | | `.` |
| `--unrestricted-paths` | | `false` |
| `--max-idle` | | `1m` after end_turn idle |
| `--log-format` | | `text` (or `json`) |
| `--base-url` | `ANTHROPIC_BASE_URL` | `api.anthropic.com` |

The worker executes shell and file operations directly on the host. Run it inside a container or other isolation boundary you control.

## Library usage

The same poll/run worker is available as library code in each SDK if you want to embed it in your own process or customise the tools. `client.beta.environments.work.worker(...)` composes the whole loop — poll → set up the workdir + download the session agent's skills → run the tools while heartbeating the work-item lease → force-stop on exit → loop. It accepts the same tool type as `client.beta.messages.tool_runner`, so any tool you define with `@beta_async_tool` (Python) or `betaZodTool` / `BetaRunnableTool` (TypeScript) can be passed alongside the defaults via `tools=`.

### Python

```python
import asyncio, os
from anthropic import AsyncAnthropic

environment_key = os.environ["ANTHROPIC_ENVIRONMENT_KEY"]

async def main() -> None:
    async with AsyncAnthropic(auth_token=environment_key) as client:
        await client.beta.environments.work.worker(
            environment_id=os.environ["ANTHROPIC_ENVIRONMENT_ID"],
            environment_key=environment_key,
            workdir="/workspace",
        ).run()

asyncio.run(main())
```

`.handle_item()` is the per-item form — for a `--on-work` script or a sandbox spawned per session, it reads the `ANTHROPIC_*` env vars and services the one already-claimed work item.

### TypeScript

```ts
import Anthropic from '@anthropic-ai/sdk';

const environmentKey = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
const client = new Anthropic({ authToken: environmentKey });
const ctrl = new AbortController();
process.once('SIGTERM', () => ctrl.abort());

await client.beta.environments.work
  .worker({
    environmentId: process.env.ANTHROPIC_ENVIRONMENT_ID!,
    environmentKey,
    workdir: '/workspace',
    signal: ctrl.signal,
  })
  .run();
```

`.handleItem()` is the per-item form (reads the `ANTHROPIC_*` env vars).

### Go

```go
// TODO: pending a released Go SDK build for the self-hosted worker.
```

## Customising the tool list

`beta_agent_toolset_20260401(env)` (Python) / `betaAgentToolset20260401(ctx)` (TypeScript) returns the `agent_toolset_20260401` implementations as a list: `bash`, `read`, `write`, `edit`, `glob`, `grep`. Filter or extend it, then pass it to `worker(...)` as `tools` — a factory invoked once per claimed session with that session's tool context:

```python
from anthropic.lib.tools import beta_async_tool
from anthropic.lib.tools.agent_toolset import (
    AgentToolContext, beta_agent_toolset_20260401, beta_bash_tool, beta_read_tool,
)

# drop grep, add a custom tool
@beta_async_tool
async def fetch_url(url: str) -> str: ...

def tools(env: AgentToolContext):
    return [t for t in beta_agent_toolset_20260401(env) if t.name != "grep"] + [fetch_url]

# or build from individual factories
def tools(env: AgentToolContext):
    return [beta_bash_tool(env), beta_read_tool(env), my_custom_tool]

client.beta.environments.work.worker(..., tools=tools)
```

```ts
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { betaAgentToolset20260401, betaBashTool } from '@anthropic-ai/sdk/tools/agent-toolset/node';

client.beta.environments.work.worker({
  ...,
  tools: (ctx) => [...betaAgentToolset20260401(ctx).filter(t => t.name !== 'grep'), myZodTool],
});
```

```go
// TODO: pending a released Go SDK build for the self-hosted worker.
```
