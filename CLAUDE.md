# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm test                                    # full suite (114 tests, ~5s)
npx vitest run test/path/file.test.js       # one file
npx vitest run -t "test name substring"     # one test
npm run test:watch                          # watch mode
npm run lint                                # 0 errors expected (warnings OK)
npm run format                              # prettier
npm link                                    # expose `walkie` CLI globally for local dev
```

Manual end-to-end smoke (no test runner):

```sh
mkdir -p /tmp/walkie-smoke && cd /tmp/walkie-smoke
node /path/to/repo/bin/walkie.js init   # operator inferred from git config user.name (or OS username)
node /path/to/repo/bin/walkie.js start
node /path/to/repo/bin/walkie.js talk "hello"
node /path/to/repo/bin/walkie.js read --limit 1
node /path/to/repo/bin/walkie.js stop
```

## The single-writer invariant (load-bearing)

`.walkie-talkie/channel.md` is the source of truth. **`src/core/channel.js` is the only path that writes it**, using `proper-lockfile` + POSIX atomic rename. Every other surface goes through the daemon's HTTP API; the daemon process is the only one that calls `channel.js` write paths.

This invariant gives multi-writer correctness without a central coordinator. Bypassing it (e.g., having the MCP server import `channel.js` directly) breaks the lockfile model and corrupts the file under concurrent writes.

**Rule:** new code that mutates `channel.md` must go through `POST /channel/message`, `PATCH /channel/message/:id`, or `POST /channel/message/:id/archive` on the per-project daemon. There is no exception.

## Architecture: three surfaces, one daemon

```
src/core/         — walkie-core library (channel, format, ids, mentions, git, history, time)
src/registry/     — per-project sessions + invitations registries
src/daemon/       — per-project Node daemon (Express + SSE + chokidar)
  daemon-entry.js  — spawn target written by lifecycle.js
  server.js        — Express app composition
  routes/          — channel, sessions, permits, events (SSE)
  watcher.js       — chokidar; emits channel.external_edit on hand-edits
  permits.js       — autonomous-write gate
  notify.js        — best-effort desktop notifications
  registry-machine.js — ~/.walkie-talkie/registry.json with dead-PID GC
src/cli/          — operator CLI (`walkie <cmd>`); uses cli/client.js HTTP wrapper
src/mcp-server/   — stdio MCP server loaded by Code/Cowork; uses http-client.js
  index.js         — Server setup, request handlers, transport
  project.js       — findProjectRoot (env WALKIE_PROJECT_ROOT or walk up)
  session.js       — per-process session join + alias cache
  tools.js         — 8 walkie_* tool handlers
  resources.js     — 3 walkie:// resources; channel/inbox is subscribable via SSE
skills/walkie-talkie/SKILL.md  — scenario-driven LLM prompt (Code + Cowork)
hooks/            — SessionStart + UserPromptSubmit; forward-compatible with Cowork #27398
commands/         — /walkie-inbox and /walkie-talk slash commands
plugin.json + .mcp.json — Anthropic plugin manifests
```

The CLI talks to the daemon via `http://127.0.0.1:<port>` (port in `.walkie-talkie/server.port`). The MCP server does the same — it never imports `src/core/channel.js`. The plugin assets are declarative; the hook script shells out to `walkie inbox --format=context`.

## Message marker is the durable record

Every message in `channel.md` has an HTML comment marker like:

```
<!-- walkie:msg id=<ULID> type=<type> from=<sessionId> from-tool=<tool> timestamp=<iso> mentions=<csv> [autonomous] -->
```

The Markdown heading above it is **rendered** from the marker, not the other way around. `parseMessage(block)` reads the marker and rebuilds the heading on edit/archive. All identity fields (`from`, `from-tool`, `timestamp`) round-trip; do not break this when extending the format. See `src/core/format.js`.

ULIDs are used for ordering — they sort lexicographically by creation time. `m.id > since` is valid for "messages after some ULID."

## Permits gate autonomous writes

Agent posts must set `autonomous: true` on `POST /channel/message`. The daemon checks for a permit (`once` / `duration` / `always`) on that session. No permit → `403 { status: "permit_required", session_id, reason, hint }`. The MCP `walkie_talk` tool surfaces this as a normal structured response so the model can show the operator the exact `walkie permit ...` command. **Permits are operator-in-the-loop on purpose** — there is no auto-claim.

## No hard delete

`walkie archive <id>` is the strongest removal. Archives are still in the file (collapsed banner); they're excluded from default reads. This is a design constraint (accountability), not an oversight.

## Known non-blocking findings

1. **`@all` and `@<tool>` mentions don't persist to `m.mentions`.** `src/daemon/routes/channel.js:90` filters `@`-prefixed entries before passing to `appendMessage`. The inbox route's `mentionedForMe` check for `'all'` / `session.tool` is therefore dead code. Direct alias mentions work; group mentions don't. If you fix this, change `resolveMentions` to return `all` / `<tool>` without the `@` prefix for those special tokens.

2. **Invitation fulfillment requires `walkie_rename`**, not just joining with `WALKIE_ALIAS`. `joinSession` doesn't trigger `fulfillInvitation`; only the `/sessions/:id/rename` route does. The SKILL.md should clarify this (it currently doesn't). Test reference: `test/e2e/two-clients.test.js` explicitly calls `codex.rename('codex-helper')` after spawn.

## Reference docs

- **Architecture diagrams:** `docs/architecture.md` (mermaid)
- **API reference:** `docs/api.md` (HTTP routes + MCP tools/resources + marker schema)
- **Setup:** `docs/setup.md`
- **FAQ:** `docs/faq.md`

(The original design spec and Plan A/Plan B construction docs are kept locally under `docs/superpowers/` and are gitignored — they were the working artifacts during initial development. Ask the maintainer if you need historical context.)

## Tags

- `plan-a-complete` — historical Plan A landing
- `plan-a-final` — Plan A + three follow-up fixes (eslint, marker round-trip, registry GC)
- `plan-b-complete` — current HEAD; full Claude integration shipped

## Test helpers worth knowing

- `test/helpers/tmp-project.js` — `createTmpProject({ operator, projectName })` returns `{ root, wtDir, channelPath }`
- `test/helpers/spawn-daemon.js` — `spawnDaemon(wtDir)` returns `{ child, port }`; `stopDaemon(daemon)` cleans up
- `test/helpers/spawn-mcp.js` — raw MCP child spawn
- `test/helpers/mock-mcp-client.js` — high-level `spawnMockClient({ projectRoot, tool, alias })` returning `inbox/talk/reply/edit/archive/sessions/rename` helpers

## Conventions

- ES modules, Node ≥ 18
- Vitest + supertest for tests; don't introduce alternatives
- Commit messages: `type(scope): subject` in the imperative (`feat`, `fix`, `docs`, `chore`, `test`, `refactor`)
- The daemon's port is dynamic (OS-assigned); always read `.walkie-talkie/server.port` rather than assuming a number
- Tests that spawn the daemon must use `spawnDaemon(project.wtDir)` (NOT `project.root`) — the helper takes the `.walkie-talkie/` path
- For machine-registry-touching tests, set `process.env.WALKIE_HOME` to a tmp dir BEFORE importing `registry-machine.js`; otherwise the test writes to the user's real `~/.walkie-talkie/registry.json`
