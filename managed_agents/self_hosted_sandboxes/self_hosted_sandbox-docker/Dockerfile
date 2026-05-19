FROM debian:12-slim
ARG ANT_SHA=cc2a5c39fc4b9aa69a43ccfc13c63523a40bf491
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
ADD https://app.stainless.com/pkg/s/anthropic-cli/${ANT_SHA}/dist.zip /tmp/ant.zip
RUN DIR=$([ "$TARGETARCH" = "arm64" ] && echo linux_linux_arm64_v8.0 || echo linux_linux_amd64_v1) \
 && unzip -oj /tmp/ant.zip "${DIR}/ant" -d /usr/local/bin \
 && chmod +x /usr/local/bin/ant && rm /tmp/ant.zip
# /workspace is the agent's working tree (skills download here, file tools are
# scoped here). Created by WORKDIR; a per-session volume is mounted over it by
# on-work.sh so the tree + skills survive across containers for one session.
WORKDIR /workspace
# Env contract (`ant beta:worker run`): ANTHROPIC_{SESSION_ID,ENVIRONMENT_ID,
# WORK_ID,ENVIRONMENT_KEY,BASE_URL}. on-work.sh also passes ANTHROPIC_AUTH_TOKEN
# (= the environment key) so the CLI's skill-download client authenticates.
# --max-idle: exit 60s after session.status_idle/end_turn, reset on any event.
ENTRYPOINT ["ant", "beta:worker", "run", "--workdir", "/workspace", "--unrestricted-paths", "--max-idle", "60s", "--log-format", "json"]
