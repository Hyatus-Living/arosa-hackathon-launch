FROM rust:1.90-trixie AS signer
RUN cargo install --locked --git https://github.com/block/buzz \
    --rev f87c10895ea35a9a2cea629fef1d7532a3fecbc5 git-sign-nostr

FROM node:22-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git openssh-client python3 ripgrep curl procps \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/codex @agentclientprotocol/codex-acp@2.2.2
COPY buzz buzz-acp buzz-dev-mcp /usr/local/bin/
COPY --from=signer /usr/local/cargo/bin/git-sign-nostr /usr/local/bin/
COPY system-prompt.txt /etc/arosa-buzz/system-prompt.txt
COPY buzz-acp.toml /etc/arosa-buzz/buzz-acp.toml
ENV BUZZ_ACP_SUBSCRIBE=config BUZZ_ACP_CONFIG=/etc/arosa-buzz/buzz-acp.toml
ENV PATH="/opt/codex/node_modules/.bin:${PATH}"
ENV HOME=/home/arosa CODEX_HOME=/home/arosa/.codex
RUN groupadd --gid 1001 arosa && useradd --uid 1001 --gid 1001 --home-dir /home/arosa arosa
WORKDIR /workspace/acres
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/buzz-acp"]
