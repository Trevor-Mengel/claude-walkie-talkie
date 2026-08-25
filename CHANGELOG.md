# Changelog

All notable changes to collabcast will be documented here. Versioning follows [Semantic Versioning](https://semver.org/). Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

The `0.2.0` entry and anything older describe the project under its former name, `claude-walkie-talkie`. They are left as written — they were accurate at the time, and the rename is a new event rather than a correction to an old one.

## [0.3.0] – unreleased

### Renamed to collabcast

The project is harness-agnostic — it coordinates concurrent coding-agent sessions of any kind — so a name that advertised one vendor's two surfaces was false advertising. `claude-walkie-talkie` is now **collabcast**.

Every user-facing identifier moved. All of these are **breaking**:

| Was | Is |
|---|---|
| npm package `claude-walkie-talkie` | `collabcast` |
| bin `walkie` | `collabcast` |
| bin `walkie-talkie-mcp` | `collabcast-mcp` |
| MCP tools `walkie_*` | `collabcast_*` |
| MCP resource scheme `walkie://` | `collabcast://` |
| state directory `.walkie-talkie/` | `.collabcast/` |
| env vars `WALKIE_*` | `COLLABCAST_*` |
| slash commands `/walkie-inbox`, `/walkie-talk` | `/collabcast-inbox`, `/collabcast-talk` |
| plugin install `walkie-talkie@claude-walkie-talkie` | `collabcast@collabcast` |
| skill `skills/walkie-talkie/SKILL.md` | `skills/collabcast/SKILL.md` |
| repo `github.com/Trevor-Mengel/claude-walkie-talkie` | `github.com/Trevor-Mengel/collabcast` |

- **`claude-code` and `claude-cowork` dropped from `package.json` keywords**, and the npm, plugin, marketplace and skill descriptions rewritten to be harness-agnostic. Advertising two Claude surfaces as the supported set was the thing this rename exists to stop doing.
- **The on-disk marker prefix deliberately did NOT change.** `<!-- walkie:msg … -->`, `<!-- walkie:body … -->`, `<!-- walkie:body-end … -->`, `<!-- walkie:rev … -->` and `WALKIE:HEADER_END` all stay. The prefix is invisible to users, `isValidMessageBody`'s unforgeability argument is built on that exact literal, and renaming it would force a migration of a file that a later change turns into a generated projection anyway. It rides the v0.2 → v0.3 importer instead.
- **No migration ships for existing state.** An existing project keeps its `.walkie-talkie/` directory, and because the SessionStart hook looks only for `.collabcast/`, the plugin silently does nothing in that project until the operator moves the directory. Fresh installs get `.collabcast/`.

### v0.3 P0 security cutover

A security pass replaced the identity and authority model wholesale. The breaks below are intentional; each one closes a specific way the old surface could be abused.

#### Removed

- **`POST /permits`, `GET /permits`, `DELETE /permits/:sessionId`** and the `--always` / `--once` / `--duration X` CLI gate. The per-post permit asked the wrong question: it authorized an *action* against a session whose identity was never verified. These routes answer 404.
- **`POST /sessions/join`** — an identity could be minted by asking for one, with no attestation. Replaced by `POST /enroll/exchange` against a human-approved, one-use enrollment code.
- **`POST /sessions/:id/rename`** — took its target from the path, and on collision renamed the *incumbent* out of the way, so any caller could steal an alias. Replaced by `POST /self/alias`, which renames the caller and nothing else.
- **`POST /sessions/invite` and `GET /sessions`** — replaced by `GET /principals`.
- **`GET /sessions/:id/inbox`** — replaced by `GET /inbox`. See "reads are non-mutating" below.
- **Six SSE event types that nothing emitted** but which still advertised themselves to every subscriber: `mention.fulfilled`, `session.joined`, `session.renamed`, `permit.granted`, `permit.revoked`, `permit.required`.

#### Changed

- **Reads are non-mutating; acknowledgement is explicit.** `GET /sessions/:id/inbox` used to advance the addressed session's read cursor as a side effect of answering, unauthenticated — so any caller could empty anyone's queue, an interrupted client lost everything it had been handed, and a read racing a write skipped the write. `GET /inbox` is now a pure function of (channel, cursors), and cursors move only through `POST /cursor/read` and `POST /cursor/ack`, always for the calling principal. On the MCP surface this is the new `collabcast_ack` tool.
- **A cursor is a message id, not an ordinal.** The old position was recomputed from whatever `channel.md` currently parsed, so one message dropping out of the parse renumbered everything after it and moved unread messages permanently below every stored cursor.
- **Each inbox view has its own cursor pair.** `include_memory_updates` selects a differently-filtered set, and a high-water mark is sound only over the set it was recorded against. Under one scalar mark, acking a later broadcast in the default view put an undelivered `memory-update` permanently below the cutoff — non-delivery recorded as acknowledgement. `collabcast_ack` and `POST /cursor/*` therefore take the same flag as the read.
- **An alias collision rejects the newcomer** with `conflict`; the principal holding the alias is never renamed or displaced.
- **Mentions persist principal ids, not alias strings.** Delivery used to match on the alias, so renaming yourself to someone else's alias redirected their directed traffic to you. `@all` and `@operator` remain symbolic, because they address the channel and a role — neither of which can be claimed by picking an alias.
- **Legacy authority fields in a request body are rejected, not ignored.** `fromSessionId`, `fromAlias`, `fromTool`, `autonomous`, `editedBy`, `archivedBy`, `sessionId`, `invitedBy`, `operator` — their presence means the caller is running pre-cutover code, and answering it politely would be answering a forged claim. Author, alias, tool, timestamp, git provenance and resolved mentions are all server-derived.
- **Managed mode fails closed.** A client no longer auto-daemonizes a service the supervisor doesn't know about; it answers `unavailable` and stops. `start` / `stop` / `status` are standalone-only.
- **Transport is a Unix domain socket** at `.collabcast/run/collabcast.sock` (directory mode `700`), replacing `127.0.0.1:<auto-port>` and the `server.port` file a local actor could rewrite to redirect CLI calls. Loopback TCP remains configurable but is off by default.
- **`config --set` validates before it writes**, using the same `validateConfig` the service and every client use, so the CLI can no longer brick a namespace from a typo.
- **`stop` verifies before it signals.** It confirms over `/health` that the listener serves *this* namespace before reading the pid file, refuses to signal itself, and refuses to signal a service whose pid file is unreadable.
- **`GET /events` requires `channel:read`.** It previously streamed every message to any unauthenticated caller that opened the socket.
- **`GET /health` discloses no filesystem paths**, and answers 503 when the HTTP listener is up but the enrollment socket is dead — a service that can never issue a first capability must not report `ok`.

#### Added

- **Capability-based authority.** Every request outside `GET /health` and `POST /enroll/exchange` carries a capability as a bearer token, verified against the store and the server's namespace, with each route demanding a named scope (`channel:read`, `channel:publish`, `channel:ack`, `self:alias`, `self:cursor`, `enroll:delegate`, …). Capabilities are rows in a SQLite store under `.collabcast/store/`.
- **Operator-approved enrollment.** A session with no credential calls `collabcast_enroll`; the OMP approval hook shows the operator the namespace, role and scopes being requested, and their approval issues a one-use, short-lived code that the client redeems for a capability. The agent never authors or sees the code — `enrollmentCode` is deliberately absent from the tool's input schema. Hook enrollment mints `root` and nothing else.
- **Delegation with store-enforced narrowing.** `POST /delegate` lets a root or operator capability mint a `goal_hub` or `listener`. Scopes may only shrink and expiry may only shorten, enforced by `issueCapability` against the parent row rather than by a check a route could forget. The parent-role fence read `root` alone until the operator credential shipped, which meant `collabcast enroll --recovery` — the one break-glass command in the product — answered `forbidden` to the one credential it is documented to use.
- **Revocation.** `DELETE /capability/:id` (`collabcast revoke <id>`), permitted for an operator or the capability's own holder, cascading over the derivation closure so a leaked parent cannot be contained by revoking it alone.
- **`collabcast_ack` and `collabcast ack <id>`** — explicit acknowledgement, monotonic and idempotent, so a client retrying after a dropped response can safely replay its last ack.
- **`collabcast whoami`** and `GET /self` — a bearer token is opaque, so a client needs a way to learn which principal it is, what it may do, and when its capability expires, read live off the capability record.
- **`collabcast_enroll`, `collabcast enroll --recovery`, `collabcast revoke`** on the tool and CLI surfaces.
- **The service mints the operator's break-glass credential.** `collabcast start` writes `.collabcast/run/operator.cred` (mode `600`, staged and published atomically) after the store is open and before the HTTP transport answers — so the readiness rule the boot order already enforced, *`/health` answering implies enrollment is possible*, now also means *the operator can act*. Nothing in `src/` or `bin/` had ever written that file: the only writers were two test helpers, so 1142 green tests sat on top of an operator CLI where `talk`, `read`, `inbox`, `ack`, `tail`, `reply`, `edit`, `archive`, `sessions`, `rename`, `whoami`, `config` and `enroll --recovery` all answered `unauthenticated` on a fresh machine. Minting is idempotent (a usable credential is never rotated, so a token a running script holds stays valid) and refuses rather than replaces a credential it will not honour — silently re-minting over a revoked token would have made `collabcast revoke` theatre. `test/e2e/fresh-install.test.js` drives `init` → `start` → `whoami` / `talk` through the shipped CLI with no fixture allowed to place the credential.
- **An `operator` scope allowlist.** `ROLE_SCOPES.operator` is every store scope, which is what "destructive authority is reached through an operator CLI attestation" had only ever been as a comment. It is not enrollable and not delegable: the service mints it, for the uid that owns the 0700 runtime directory.
- **A detached service's stderr is kept.** `collabcast start` spawned the service with `stdio: 'ignore'`, so every operator-facing boot refusal — a wedged `hook.secret`, an unusable `operator.cred` — went to /dev/null and reached the operator as `did not begin answering within the startup window` ten seconds later, with nothing in it to act on. Stderr now lands in `.collabcast/run/service.err` (truncated per start) and a failed start quotes its tail back; a service that has already exited is no longer waited out.
- **An append-only audit table.** Every authority decision is recorded with actor, action, subject and outcome. `redactDetail` replaces any `*Token`-keyed value, so a token cannot reach a row.
- **A `busy` error code carrying `Retry-After: 1`** for a write that lost the channel lock race. It previously surfaced as `internal`, which reads as "report a bug" — an agent had no way to know retrying was the correct remedy. Deliberately distinct from `conflict`, where retrying unchanged is pointless.
- **An `unavailable` error code** for "the supervised service is not listening", distinct from `internal`: nothing failed, and the caller's remedy is different.
- **A test isolation harness.** `test/helpers/isolation.js` throws before any test body runs if the process could reach live user state, and refuses the real `~/.collabcast` and `~/.walkie-talkie`. `test/scratch/**` is excluded from the suite so a scratch probe cannot change its file count or exit code.

#### Security

- **`PATCH /channel/message/:id` now validates the body.** It never did, so an edit could write a literal `<!-- walkie:msg … -->` into the file and forge a second message block attributed to whoever the forged marker named. Posting and editing share exactly the same check, and length and markup are separate refusals so an oversized but otherwise clean body is not told it contains a control comment.
- **Headings are encoded on the same scheme as marker values.** A heading is line 0 of every block, one line above the real marker, so a heading able to carry a complete marker comment could name any id and any author.
- **Message bodies are fenced** by `<!-- walkie:body id=… -->` / `<!-- walkie:body-end id=… -->`.
- **Enrollment refusals are opaque.** A bad secret and an unknown namespace collapse to one message, so a caller cannot enumerate namespaces or confirm a stolen secret against the wrong project. The audit row records which it really was.
- **Revocation cannot enumerate.** A capability that does not exist and one belonging to another namespace both answer `404`.
- **The roster discloses no cross-system linkage.** `GET /principals` emits id, role, alias and creation time — never a token, a token hash, or `paseoAgentId`.
- **Credential files are mode-checked, not just mode-set.** `operator.cred` is refused if it is readable beyond its owner; `hook.secret` and the store are `600`; `run/` is `700`.
- **The notifier consumes only a principal id and an enum-validated message type.** No body, alias or archive reason reaches `node-notifier`.
- **The service refuses to start while `channel.md` is tracked in git**, and `init` writes the `.gitignore` rule before reporting success. A committed channel is a supply-chain vector, not a tidiness problem.
- The five medium-severity items deferred from `v0.2.0` are all closed. See `SECURITY.md`.

#### Known gaps

- **The operator credential has no in-band re-issue path.** `start` mints it, but refuses to mint over one it will not honour, so recovery from a revoked or wedged `operator.cred` is `rm` plus a restart — which requires the uid that owns `run/`. That is the intended security property; there is still no `collabcast reissue`.
- **`GET /events` is best-effort** — it replays nothing and survives no restart, so a reconnecting subscriber can miss what was emitted while it was away.
- **Channel writes and their audit rows are not one transaction.** A file rename cannot join a SQLite transaction; the file is written first, so the failure mode is a missing row rather than a fabricated one.

## [0.2.0] – 2026-05-16

Initial public release.

### Added

- **Operator CLI** (`walkie`) — 19 subcommands covering channel init, daemon lifecycle, messaging (talk/reply/edit/archive), session management (sessions/rename/alias/invite), permits (permit/remove), config, logs, and machine-wide status.
- **Per-project local daemon** — Express HTTP server bound to `127.0.0.1:<auto-port>` with SSE event stream, chokidar file watcher, desktop notifications, atomic-append-at-top channel writes via `proper-lockfile`, and a machine-wide registry of running projects with dead-PID garbage collection.
- **MCP server** (`walkie-talkie-mcp`) — 8 tools (`walkie_inbox`, `walkie_read`, `walkie_talk`, `walkie_reply`, `walkie_edit`, `walkie_archive`, `walkie_sessions`, `walkie_rename`) and 3 resources (`walkie://channel/inbox` with SSE subscription, `walkie://channel/recent`, `walkie://sessions/active`).
- **Claude Code plugin** with scenario-driven `SKILL.md`, SessionStart + UserPromptSubmit hooks (forward-compatible with Cowork issue [#27398](https://github.com/anthropics/claude-code/issues/27398)), `/walkie-inbox` and `/walkie-talk` slash commands, and a self-hosted marketplace via `.claude-plugin/marketplace.json`.
- **Claude Cowork support** via Claude Desktop's MCP bridge — installed at `claude_desktop_config.json` with a pinned `WALKIE_PROJECT_ROOT`. See `docs/setup.md` for the install path.
- **Operator name auto-inference** in `walkie init` (git config user.name → OS username) with strict validation against injection.
- **Channel format** — Markdown file at `.walkie-talkie/channel.md` with newest-first message blocks, durable marker comments preserving sessionId, alias, tool, timestamp, mentions, reply-to, revision, edited-at, archive state through edits.
- **Permission model** — autonomous agent writes blocked by default; operator authorizes per-session with `--once`, `--duration X`, or `--always`.
- **Full documentation** — `docs/architecture.md` (mermaid diagrams), `docs/setup.md` (install + Cowork), `docs/api.md` (HTTP + MCP reference + marker schema + input validation rules), `docs/faq.md`, `examples/demo-while-presenting/`, `CONTRIBUTING.md`.

### Security

A pre-publish audit (`security-sentinel`) surfaced five ship-blockers; all closed before release:

- Charset validation for `sessionId`, `fromAlias`, `fromTool` at every daemon route boundary — closes a marker-field-injection forgery where a crafted POST could appear authored by `operator`.
- Body and `archivedReason` content restrictions — closes a sibling-message smuggling attack via `\n## ` delimiters in message bodies.
- ULID format validation on `:id` route params + path-resolve confinement in `src/core/history.js` — closes a `..%2F` LFI primitive on `GET /channel/message/:id`.
- Operator-name sanitization in `walkie init` — closes a supply-chain-shaped attack where a poisoned `.git/config` could inject a forged `<!-- WALKIE:HEADER_END -->` marker into a freshly-init'd channel.
- Origin + Host header rejection middleware on the daemon — defangs DNS-rebinding-style browser attacks against the local-only daemon.

Five additional medium-severity findings deferred to the v0.2.1 hardening pass. See `SECURITY.md` for details.

### Known limitations

- **`claude.ai` web chat is not supported.** Cloud-only execution can't reach a local 127.0.0.1 daemon. By design.
- **Single project per Cowork install entry.** `WALKIE_PROJECT_ROOT` is fixed at MCP-server-spawn time; multi-project Cowork use requires multiple named entries in `claude_desktop_config.json`. v0.3.0 design question.
- **Cowork hooks don't fire** ([anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398)) — plugin's hooks are forward-compatible and activate when the upstream fix ships. Until then, the skill calls `walkie_inbox` on every operator turn.

### Verified

- 153/153 tests passing across 37 test files (unit, integration, security regression, end-to-end harness with two mock MCP clients).
- 0 lint errors.
- Claude Code install path verified end-to-end.
- Claude Cowork install path verified end-to-end (Cowork session posted to a channel; message landed with correct `from-tool=claude-cowork` attribution).

[0.3.0]: https://github.com/Trevor-Mengel/collabcast/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Trevor-Mengel/collabcast/releases/tag/v0.2.0
