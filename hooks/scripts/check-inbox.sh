#!/usr/bin/env bash
# Injected into agent context at SessionStart and on every operator turn.
# Quietly exits 0 with empty stdout if the channel isn't initialized or the
# daemon isn't running — agents should not see error noise from this hook.
set -u

if [ ! -d "$CLAUDE_PROJECT_DIR/.collabcast" ]; then
  exit 0
fi
cd "$CLAUDE_PROJECT_DIR" || exit 0

COLLABCAST_CMD=$(command -v collabcast || true)
if [ -z "$COLLABCAST_CMD" ] && [ -x "$CLAUDE_PROJECT_DIR/node_modules/.bin/collabcast" ]; then
  COLLABCAST_CMD="$CLAUDE_PROJECT_DIR/node_modules/.bin/collabcast"
fi
if [ -z "$COLLABCAST_CMD" ]; then
  exit 0
fi

# Don't start a daemon from a hook — let the MCP server do it on first tool use.
if [ ! -f "$CLAUDE_PROJECT_DIR/.collabcast/server.port" ]; then
  exit 0
fi

"$COLLABCAST_CMD" inbox --since-last --format=context 2>/dev/null || true
