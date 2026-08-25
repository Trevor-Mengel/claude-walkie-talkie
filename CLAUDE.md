# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The product is **collabcast** (npm package `collabcast`, repo `Trevor-Mengel/collabcast`). It was previously named `claude-walkie-talkie`; see "Naming" below for the one place the old name deliberately survives.

## Commands

```sh
npm test                                    # full suite
npx vitest run test/path/file.test.js       # one file
npx vitest run -t "test name substring"     # one test
npm run test:watch                          # watch mode
npm run lint                                # 0 errors expected (warnings OK)
npm run format                              # prettier
npm link                                    # expose `collabcast` CLI globally for local dev
```

Manual end-to-end smoke (no test runner). Standalone mode is required — in the default `managed` mode clients refuse to start a service behind the supervisor's back:

```sh
mkdir -p /tmp/collabcast-smoke && cd /tmp/collabcast-smoke && git init -q
node /path/to/repo/bin/collabcast.js init --mode standalone   # operator inferred from git config user.name (or OS username)
node /path/to/repo/bin/collabcast.js start
node /path/to/repo/bin/collabcast.js whoami
node /path/to/repo/bin/collabcast.js talk "hello"
node /path/to/repo/bin/collabcast.js status
node /path/to/repo/bin/collabcast.js stop
```

`whoami` / `talk` / `read` / `inbox` and every other command past `init` authenticate with `.collabcast/run/operator.cred` (mode `0600`), which `start` mints — see `src/authority/operator-credential.js`. A smoke run needs no fixture to place it, and `test/e2e/fresh-install.test.js` drives exactly this sequence through the shipped CLI. Until v0.3 nothing in `src/` wrote that file at all: 1142 tests were green over an unusable operator CLI because the fixtures wrote the credential themselves. **A fixture that constructs the subject cannot detect the subject failing to construct itself** — the authority socket was the same defect twice before. Any new artifact the product is supposed to create needs a test that lets the product create it.

That sequence is verified: `init` scaffolds `.collabcast/{channel.md,config.json,logs,.sessions,store/collabcast.db}` and registers the namespace in `$COLLABCAST_HOME/.collabcast/identities.json`; `start` binds `run/collabcast.sock` and `run/authority.sock` and mints `run/{hook.secret,operator.cred}`; `status` reports the pid, mode and schema version. **Set `COLLABCAST_HOME` to a scratch directory before running it**, or `init` writes into the real `~/.collabcast/identities.json`.

The CLI's exit codes let a hook or script branch without scraping stderr: `0` ok, `1` error, `2` denied (`unauthenticated`, `forbidden`, `not_owner`, `wrong_namespace`, `scope_required`, `permit_required`, `permit_invalid`, `conflict`, `not_found`), `3` service unavailable. See `EXIT_*` and `DENIED_CODES` in `src/cli/index.js`.

## The single-writer invariant (load-bearing)

`.collabcast/channel.md` is the source of truth. **`src/core/channel.js` is the only path that writes it**, using `proper-lockfile` + POSIX atomic rename. Every other surface goes through the service's HTTP API; the service process is the only one that calls `channel.js` write paths.

This invariant gives multi-writer correctness without a central coordinator. Bypassing it (e.g., having the MCP server import `channel.js` directly) breaks the lockfile model and corrupts the file under concurrent writes.

**Rule:** new code that mutates `channel.md` must go through `POST /channel/message`, `PATCH /channel/message/:id`, or `POST /channel/message/:id/archive` on the per-namespace service. There is no exception.

## Architecture: three surfaces, one service

```
src/core/         — channel, format, ids, mentions, git, history, time, validate
src/store/        — SQLite authority store; schema.sql is the shape of record
  principals.js    — the roster (roles: root, goal_hub, listener, operator, legacy)
  capabilities.js  — issue / verify / revoke; SCOPES is the scope vocabulary
  cursors.js       — per-principal read + ack marks, one pair per inbox view
  audit.js         — append-only decision log; redacts *Token values
src/identity/     — namespace resolution, host identity map, path canonicalisation,
                    and errors.js — the ONE error vocabulary (ERROR_CODES)
src/config/       — schema.js holds every product default; load.js validates
src/authority/    — operator-approval enrollment (hook socket, policy, secret, paths)
src/daemon/       — the per-namespace service
  daemon-entry.js  — spawn target written by lifecycle.js
  server.js        — Express composition, STATUS_BY_CODE mapping, GET /health
  auth.js          — requireCapability, requireScope, legacy-authority-field rejection
  transport.js     — Unix socket (+ optional loopback TCP) and path resolution
  lifecycle.js     — start / stop / status, standalone mode only
  routes/          — channel, inbox, cursor, principals, enroll, capability, events
  watcher.js       — chokidar; emits channel.external_edit on hand-edits
  notify.js        — best-effort desktop notifications
src/client/       — the one HTTP client both clients use (api, context, credentials, events)
src/cli/          — operator CLI (`collabcast <cmd>`); uses cli/client.js
src/mcp-server/   — stdio MCP server loaded by the agent host
  index.js         — Server setup, request handlers, transport
  project.js       — findProjectRoot (env COLLABCAST_PROJECT_ROOT or walk up)
  capability.js    — in-memory capability holder; enrollment-code handling
  tools.js         — 10 collabcast_* tool handlers
  resources.js     — 3 collabcast:// resources; channel/inbox is subscribable via SSE
skills/collabcast/SKILL.md   — scenario-driven LLM prompt
hooks/            — SessionStart + UserPromptSubmit; forward-compatible with Cowork #27398
commands/         — /collabcast-inbox and /collabcast-talk slash commands
omp-extension/    — the OMP approval hook that turns an operator click into an enrollment code
templates/channel.md — scaffold read by src/cli/init.js
plugin.json + .mcp.json + .claude-plugin/marketplace.json — plugin manifests
```

The CLI and the MCP server both reach the service over a Unix socket at `<runtimeRoot>/collabcast.sock`, where `runtimeRoot` defaults to `<projectRoot>/.collabcast/run`. Neither imports `src/core/channel.js`. Precedence for `runtimeRoot`: explicit argument, then `COLLABCAST_RUNTIME_ROOT`, then the default. The plugin assets are declarative; the hook script shells out to `collabcast inbox --format=context`.

## Authority: capabilities, not permits

There is no per-post permission gate. A caller proves who it is with a capability presented as `Authorization: Bearer <token>`, and each route demands a named scope (`channel:read`, `channel:publish`, `channel:ack`, `self:alias`, `self:cursor`, `enroll:delegate`, …). `src/daemon/auth.js` is the whole boundary: `requireCapability` authenticates, `requireScope` authorizes.

Capabilities are minted two ways and no others:

1. **`POST /enroll/exchange`** — the only route mounted before authentication, because it is how a caller with no credential gets one. It redeems a one-use, short-lived enrollment code that exists only because a human clicked Approve in the OMP hook dialog. Hook enrollment mints `root` and nothing else (`src/authority/policy.js`).
2. **`POST /delegate`** — a `root` capability mints a narrower one. `issueCapability` enforces scope-subset and expiry-ceiling against the parent row, so a widened request is refused by the store rather than by a check a route could forget.

`src/store/permits.js` still exists as a store table, but nothing on the write path consults it. Do not reintroduce a permit check on publish.

## Message marker is the durable record

Every message in `channel.md` has an HTML comment marker like:

```
<!-- walkie:msg id=<ULID> type=<type> from=<principalId> from-tool=<tool> timestamp=<iso> mentions=<csv> [autonomous] -->
```

The Markdown heading above it is **rendered** from the marker, not the other way around. `parseMessage(block)` reads the marker and rebuilds the heading on edit/archive. All identity fields (`from`, `from-tool`, `timestamp`) and git provenance round-trip; do not break this when extending the format. Bodies are additionally fenced by `<!-- walkie:body id=… -->` / `<!-- walkie:body-end id=… -->`. See `src/core/format.js`.

`mentions` holds **principal ids**, plus the two symbolic tokens `@all` and `@operator`. It never holds an alias string — matching on aliases let a rename redirect another principal's directed traffic.

ULIDs are used for ordering — they sort lexicographically by creation time. `m.id > since` is valid for "messages after some ULID", and every cursor is a message id for exactly this reason. A cursor is never an ordinal: recomputing a position from whatever currently parses moved stored cursors past undelivered messages.

## Reads never mutate

`GET /inbox` and every MCP resource read are pure functions of (channel, cursors). Cursors move only through `POST /cursor/read` and `POST /cursor/ack`, always for the calling principal — there is no `:principalId` path parameter.

The two inbox views (`include_memory_updates` false / true) carry **separate cursor pairs**. Acking must pass the same flag the read passed: a high-water mark is sound only over the set it was recorded against.

## No hard delete

`collabcast archive <id>` is the strongest removal. Archives are still in the file (collapsed banner); they're excluded from default reads. This is a design constraint (accountability), not an oversight. Editing is authorship — only the author may change a body, operator included. Archiving is moderation — the author or an `operator`.

## Naming

The product rename to collabcast deliberately did **not** move the on-disk marker prefix. `<!-- walkie:msg … -->`, `<!-- walkie:body … -->`, `<!-- walkie:rev … -->`, `<!-- walkie:body-end … -->`, `WALKIE:HEADER_END`, the `MARKER_*` / `WALKIE_COMMENT_RE` regexes in `src/core/{format,channel,validate,history}.js`, and `isValidMessageBody`'s rejection of the literal `<!-- walkie:` all stay as they are. Reasons: the prefix is invisible to users, `isValidMessageBody`'s unforgeability argument is built on that exact literal, and renaming it would force a migration of a file that a later change turns into a generated projection anyway. Do not "finish" this rename.

Everything user-facing did move: package and bins (`collabcast`, `collabcast-mcp`), MCP tools (`collabcast_*`), resource scheme (`collabcast://`), state directory (`.collabcast`), env vars (`COLLABCAST_*`).

## Known gaps

1. **The operator credential cannot be re-issued without filesystem access.** `start` mints `.collabcast/run/operator.cred`, but it refuses to mint over one it will not honour (revoked, expired, loose mode, unparseable) rather than replacing it — silently re-minting over a revoked token would make `collabcast revoke` theatre. Recovery is `rm` + restart, which needs the uid that owns `run/`. There is no `collabcast reissue`.
2. **SSE is best-effort.** `GET /events` replays nothing and survives no restart; a reconnecting subscriber can miss events. `EVENT_TYPES` in `src/daemon/routes/events.js` is asserted against the real emitters by `test/daemon/routes/events.test.js`, so the list cannot drift silently.
3. **Channel-write audit rows are not transactional with the write.** A file rename cannot join a SQLite transaction, so `src/daemon/routes/channel.js` writes the file first and the audit row second. Ordering guarantees no fabricated rows, but a crash between the two loses a row. Closing it needs a durable intent row in `src/core/channel.js`, not a change to the route.

## Reference docs

- **Architecture diagrams:** `docs/architecture.md`
- **API reference:** `docs/api.md` (HTTP routes + MCP tools/resources + marker schema)
- **Setup:** `docs/setup.md`
- **FAQ:** `docs/faq.md`

## Test helpers worth knowing

- `test/helpers/isolation.js` — loaded as a vitest `setupFile`; **throws before any test body runs** if the process could reach live user state. `REQUIRED_ROOT_ENV` must all name disposable paths, and `FORBIDDEN_ROOTS` includes the real `~/.collabcast` and `~/.walkie-talkie`. Never work around it.
- `test/helpers/global-setup.js` — builds the per-run disposable tree and exports the `COLLABCAST_*` / `GIT_CONFIG_*` variables.
- `test/helpers/registered-namespace.js` — `createRegisteredNamespace({ namespace, mode, config })`; gives you a registered namespace, a `runtimeRoot`, and `writeOperatorCredential()`.
- `test/helpers/stack.js` — `createStack({ mode, namespace, operator })` stands up store + authority + server; `socketRequest()` speaks HTTP over the Unix socket.
- `test/helpers/spawn-daemon.js` — `spawnDaemon({ cwd, env, socketPath })` / `stopDaemon(daemon)`.
- `test/helpers/spawn-mcp.js` — raw MCP child spawn; `MCP_BIN` points at `bin/collabcast-mcp.js`.
- `test/helpers/mock-mcp-client.js` — `spawnMockClient({ env, cwd, capability })`; `TOOL_NAMES` is the asserted tool inventory.
- `test/helpers/tmp-project.js` — `createTmpProject({ operator, projectName })` returns `{ root, wtDir, channelPath }`.

## Conventions

- ES modules, Node ≥ 22
- Vitest + supertest for tests; don't introduce alternatives
- Commit messages: `type(scope): subject` in the imperative (`feat`, `fix`, `docs`, `chore`, `test`, `refactor`)
- **Every product default lives in `src/config/schema.js`.** Import `DEFAULT_CONFIG` or its helpers rather than repeating a literal.
- **Every error is a `CollabcastError` with a code from `ERROR_CODES`** (`src/identity/errors.js`). An unlisted code throws at construction so it cannot reach a client. Never put a token, a secret, or a credential path into `message` or `detail`.
- Tests that need a namespace use `createRegisteredNamespace` or `createStack`, not hand-built directories — the isolation harness will reject anything outside the disposable tree.
- `test/scratch/**` is excluded from the suite by `vitest.config.js`. Put throwaway probes there (or in `/tmp`), never under a collected `test/` path.
