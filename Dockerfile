# Jarvis runtime image
# Long-lived Claude Code session with MCP servers, controlled via Telegram.

FROM oven/bun:1-debian AS base

# Install system deps Claude Code needs (git, curl, ca-certs)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

# Install dependencies
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile || bun install

# Copy source
COPY . .

# Build TypeScript
RUN bun run build || true

# Persistent volume for Claude Code auth + state
VOLUME ["/data"]
ENV CLAUDE_CONFIG_DIR=/data/claude
ENV JARVIS_STATE_DIR=/data/jarvis

# Entry script launches Claude Code with --dangerously-skip-permissions
COPY src/runtime/entry.sh /entry.sh
RUN chmod +x /entry.sh

# tini for proper signal handling
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/entry.sh"]
