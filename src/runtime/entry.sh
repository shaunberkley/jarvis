#!/usr/bin/env bash
# Jarvis runtime entrypoint.
# Launches a long-lived Claude Code session with all permissions auto-approved
# and the full MCP config loaded.

set -euo pipefail

JARVIS_STATE_DIR="${JARVIS_STATE_DIR:-/data/jarvis}"
CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/claude}"
MCP_CONFIG_PATH="${MCP_CONFIG_PATH:-/app/config/mcp.json}"
JARVIS_WORKDIR="${JARVIS_WORKDIR:-/app}"

mkdir -p "$JARVIS_STATE_DIR" "$CLAUDE_CONFIG_DIR"

# Restore Claude Code auth from the mounted secret if it isn't present yet.
# CLAUDE_OAUTH_TOKEN is set as a Fly secret copied from Bob's existing auth,
# so Jarvis runs under the same Claude Max subscription.
if [[ -n "${CLAUDE_OAUTH_TOKEN:-}" && ! -f "$CLAUDE_CONFIG_DIR/credentials.json" ]]; then
  echo "[jarvis] bootstrapping Claude auth from CLAUDE_OAUTH_TOKEN"
  cat > "$CLAUDE_CONFIG_DIR/credentials.json" <<EOF
{ "oauth_token": "${CLAUDE_OAUTH_TOKEN}" }
EOF
  chmod 600 "$CLAUDE_CONFIG_DIR/credentials.json"
fi

# Start the inbound webhook server in the background.
# Hono app handles Fireflies, etc. POSTs and pushes events into the running
# Claude Code session via the channels MCP.
if [[ -f "$JARVIS_WORKDIR/src/webhooks/server.ts" ]]; then
  echo "[jarvis] starting webhook server on :3000"
  (cd "$JARVIS_WORKDIR" && bun run src/webhooks/server.ts) &
fi

# Launch Claude Code. --dangerously-skip-permissions is required so the
# autonomous session does not block on per-tool-call approval prompts.
cd "$JARVIS_WORKDIR"

echo "[jarvis] launching Claude Code with --dangerously-skip-permissions"
exec claude \
  --dangerously-skip-permissions \
  --mcp-config "$MCP_CONFIG_PATH"
