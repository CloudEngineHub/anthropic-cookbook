FROM debian:12-slim
ARG ANT_SHA=cc2a5c39fc4b9aa69a43ccfc13c63523a40bf491
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
ADD https://app.stainless.com/pkg/s/anthropic-cli/${ANT_SHA}/dist.zip /tmp/ant.zip
RUN DIR=$([ "$TARGETARCH" = "arm64" ] && echo linux_linux_arm64_v8.0 || echo linux_linux_amd64_v1) \
 && unzip -oj /tmp/ant.zip "${DIR}/ant" -d /usr/local/bin \
 && chmod +x /usr/local/bin/ant && rm /tmp/ant.zip
WORKDIR /workspace
# --max-idle: exit 60s after session.status_idle/end_turn, reset on any event.
ENTRYPOINT ["ant", "beta:worker", "run", "--workdir", "/workspace", "--unrestricted-paths", "--max-idle", "60s", "--log-format", "json"]
