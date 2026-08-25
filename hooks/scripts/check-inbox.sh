#!/usr/bin/env bash
#
# Renders the operator's collabcast inbox into agent context at SessionStart and on every
# operator turn.
#
# ---------------------------------------------------------------------------------------------
# Why this file was rewritten
# ---------------------------------------------------------------------------------------------
# The v0.2 version of this script was dead on every invocation in v0.3, and could not report
# that it was dead. Three separate faults, all of which survived the rename because nothing ever
# executed the script:
#
#   1. It gated on `.collabcast/server.port`. v0.3 has no such file — the service listens on a
#      Unix socket at `<runtimeRoot>/collabcast.sock` and `pidFile`/`portFile` were removed
#      (see `src/mcp-server/http-client.js` and `src/core/channel.js`). The guard was therefore
#      false on every run and the script exited 0 having done nothing.
#   2. It passed `--since-last`, an option `collabcast inbox` has never had in v0.3
#      (`src/cli/index.js` defines only `--limit`, `--format` and `--include-memory-updates`),
#      so even past the guard the command would have failed on an unknown option.
#   3. It ended in `2>/dev/null || true`, which made a broken script, a missing binary and a
#      rejected credential all indistinguishable from "no new messages".
#
# ---------------------------------------------------------------------------------------------
# Readiness: the inbox call IS the readiness check
# ---------------------------------------------------------------------------------------------
# There is deliberately no separate "is the service up?" probe here. `collabcast inbox` connects
# to the namespace's socket itself and the CLI's exit code is its own answer, so this script
# branches on that instead of re-deriving readiness:
#
#   0 -> the service answered; print what it said.
#   3 -> EXIT_UNAVAILABLE: nothing is listening for this namespace. Expected and quiet.
#   * -> a real fault (missing binary, unreadable config, rejected or revoked credential).
#        Surfaced on stderr with the CLI's own words.
#
# Three reasons not to probe first:
#
#   * A second implementation of readiness is a second thing that can drift. `readHealth` in
#     `src/daemon/lifecycle.js` already owns "status 200 AND ok === true"; bash re-deriving it
#     from the presence of a socket file would be a new, weaker, silently-diverging copy.
#   * A probe followed by a read is a race. One call cannot disagree with itself.
#   * Gating on `collabcast status` would recreate fault (1) above for every managed install:
#     `status` deliberately REFUSES in managed mode (`forbidden`, exit 2) because lifecycle
#     there belongs to Paseo, so a hook gated on it would be permanently silent exactly where
#     the operator relies on it most.
#
# One nuance worth stating, because it surprises people: a project that has been `init`ed but
# never `start`ed reports exit 2 (`unauthenticated`), not 3, because `operator.cred` is written
# by `start`. That is surfaced rather than swallowed on purpose — an install with no service that
# has ever run is INCOMPLETE, messages will never arrive, and the CLI's message names the
# remedy. A service that was started and then stopped is different: the credential survives a
# stop, so that case reports 3 and stays quiet, which is the deliberate-operator-choice case.
#
# Nothing here reads `.collabcast/server.port`, `collabcast.pid`, `collabcast.sock` or any other
# runtime artifact. A stale v0.2 port file or a pid file left behind by a killed process
# therefore cannot change what this script does.
#
# ---------------------------------------------------------------------------------------------
# This script does not acknowledge
# ---------------------------------------------------------------------------------------------
# `GET /inbox` is non-mutating in v0.3 and acknowledgement is a separate explicit act
# (`collabcast ack <id>`, or the `collabcast_ack` MCP tool). This script keeps it that way, on
# purpose: a hook fires whether or not the model ever attends to what it injected, so acking
# here would record non-delivery as acknowledgement — the exact failure the v0.3 cursor rework
# existed to remove. Unread messages are therefore re-rendered on each turn until the agent
# acks them, which is the correct idempotent behaviour for an at-least-once notification.
#
# The CLI's own output is passed through verbatim, including its "(no new messages)" line. That
# line is not noise: a live-but-empty channel saying so is the only thing that distinguishes it
# from a channel that has gone silent because this hook is broken again.

set -u

# One place for "collabcast is not working here", so no branch below can accidentally report a
# fault as an empty inbox. Everything goes to stderr, which is the operator's channel: a broken
# install is theirs to fix and the model can do nothing with it. Headline first, then the cause,
# then (at the call site) whatever the CLI itself said — so the consequence is never buried.
fault() {
  printf 'collabcast hook: inbound messages are NOT being delivered to this session.\n' >&2
  for line in "$@"; do
    printf 'collabcast hook: %s\n' "$line" >&2
  done
}

# --- where are we -----------------------------------------------------------------------------
# The harness sets CLAUDE_PROJECT_DIR. Without it there is no project to resolve, and without
# `.collabcast/` this project has never been initialised — neither is a fault, both are quiet.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ] || [ ! -d "$PROJECT_DIR/.collabcast" ]; then
  exit 0
fi
if ! cd "$PROJECT_DIR"; then
  # We just stat'd `.collabcast/` inside it, so this is a permissions anomaly rather than an
  # uninitialised project — and it stops delivery just as dead.
  fault "cannot enter CLAUDE_PROJECT_DIR ($PROJECT_DIR)"
  exit 1
fi

# --- which CLI --------------------------------------------------------------------------------
# Resolved relative to this script first, so the hook runs the CLI from the same package it
# shipped in and cannot end up driving a different version of the product than it was written
# against. `$CLAUDE_PLUGIN_ROOT` resolves to the same tree but is not guaranteed to be exported.
# `|| exit 0` deliberately absent: failing to locate ourselves is not a reason to go quiet, it
# just means falling back to the other two lookups, so an empty result is tolerated and guarded.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
PACKAGE_ROOT=$(CDPATH= cd -- "${SCRIPT_DIR:-.}/../.." && pwd -P)

COLLABCAST_CMD="${COLLABCAST_CMD:-}"
if [ -z "$COLLABCAST_CMD" ] && [ -n "$PACKAGE_ROOT" ] && [ -x "$PACKAGE_ROOT/bin/collabcast.js" ]; then
  COLLABCAST_CMD="$PACKAGE_ROOT/bin/collabcast.js"
fi
if [ -z "$COLLABCAST_CMD" ] && [ -x "$PROJECT_DIR/node_modules/.bin/collabcast" ]; then
  COLLABCAST_CMD="$PROJECT_DIR/node_modules/.bin/collabcast"
fi
if [ -z "$COLLABCAST_CMD" ] && command -v collabcast >/dev/null 2>&1; then
  # Deliberately not `$(command -v collabcast || true)`: `|| true` is the idiom that made the
  # previous version of this script unable to report its own failure, so it appears nowhere here.
  COLLABCAST_CMD=$(command -v collabcast)
fi
if [ -z "$COLLABCAST_CMD" ]; then
  # `.collabcast/` exists, so this project HAS used collabcast; the binary being gone is a
  # broken install, not an absence. Reported rather than swallowed: silence here is
  # indistinguishable from an empty inbox, and the operator would keep believing the channel
  # works while every inbound message goes undelivered.
  fault "no collabcast CLI found (looked in ${PACKAGE_ROOT:-.}/bin, $PROJECT_DIR/node_modules/.bin, and \$PATH)"
  exit 1
fi

# --- ask ---------------------------------------------------------------------------------------
# stderr goes to a file rather than to this script's stderr so that the expected
# "not running" case can stay genuinely quiet while a real fault still gets quoted in full.
# stdout is buffered for the same reason: a command that fails must not have already injected
# half an inbox into the model's context.
if ! STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/collabcast-hook.XXXXXX"); then
  fault 'could not create a temporary file to capture the CLI diagnostics'
  exit 1
fi
trap 'rm -f "$STDERR_FILE"' EXIT

OUTPUT=$("$COLLABCAST_CMD" inbox --format=context 2>"$STDERR_FILE")
STATUS=$?

# Mirrors EXIT_UNAVAILABLE in `src/cli/index.js`. `test/packaging/hooks.test.js` asserts the two
# agree, because an unasserted copy of a constant is how this project has been bitten before.
EXIT_UNAVAILABLE=3

if [ "$STATUS" -eq "$EXIT_UNAVAILABLE" ]; then
  # No service for this namespace. Expected whenever the operator has simply not started one,
  # and not something to nag about on every prompt.
  exit 0
fi

if [ "$STATUS" -ne 0 ]; then
  fault "\`collabcast inbox\` failed (exit $STATUS)"
  # The CLI's own words, verbatim, because a summary of them is not a diagnosis.
  if [ -s "$STDERR_FILE" ]; then
    cat "$STDERR_FILE" >&2
  fi
  # 1, never 2: exit 2 blocks the operator's prompt, and collabcast being unwell is not a
  # reason to stop them working. This surfaces to the operator without interrupting them.
  exit 1
fi

# Command substitution strips trailing newlines; re-add exactly one so the injected block ends
# cleanly. An empty body prints nothing at all rather than a stray blank line.
if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi
exit 0
