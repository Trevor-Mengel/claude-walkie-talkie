# AGENTS.md

Universal guidance for any coding agent working in this repository — Claude Code, Codex, OMP, Cursor, or anything else. `CLAUDE.md` points here; this is the single source of truth.

The product is **collabcast** (npm package `collabcast`, repo `Trevor-Mengel/collabcast`). It was previously `claude-walkie-talkie`; see "Naming" for the one place the old name deliberately survives.

---

## Status and handoff — read this first

**Where the work is:** worktree `/Users/trev/.paseo/worktrees/3ax0748s/lucky-whale`, branch `lucky-whale`, HEAD `a1fa688`. Audited base is `4824784` (the v0.2 tree). Three commits sit on top:

| Commit | What |
|---|---|
| `e0d7824` | v0.3 P0 security cutover — authenticated, namespace-scoped authority store replacing the unauthenticated flat-file bus |
| `3f694f8` | Rename to Collabcast; operator-credential bootstrap fix |
| `a1fa688` | Three P0 adoption blockers + a test-isolation defect |

**Suite:** 102 files / 1,226 tests / exit 0 — re-verified twice while auditing this file (`npm test`, exit 0 both runs). The "stable over 11 consecutive full runs" figure comes from earlier in the session and was not re-derived here.

**P0 status: NOT closed.** An independent adoption review returned P0 REJECT on three findings. All three are fixed and were re-reviewed **CLEAN / CLEAN WITH NOTES with no blocker**, and a fourth defect found during verification is also fixed. These verdicts are review outcomes from this session's reviewer agents, not something the tree asserts — nothing in `src/` or `test/` records a review verdict, so they cannot be re-derived by grepping. What *is* re-derivable is the fix evidence: commit `a1fa688` and the suite. The operator holds the closing decision — do not claim P0 closed on the strength of this file.

**P1 status: NOT implemented, accurately.** Verify before believing anything else: `event`, `thread`, `lease`, and `handoff` have **no writer anywhere in `src/`** — both `grep -rE "INSERT INTO (event|thread|lease|handoff)" src/` and the matching `UPDATE` grep return nothing. They exist in `src/store/schema.sql` as designed shape only. So the durable event log, ordered replay / `Last-Event-ID`, the fenced single listener, and two-phase Paseo handoff receipts **do not exist**. Cursors are implemented but anchored to message ULIDs, not `event_id`, and must re-anchor when the log lands.

**Invariant 6 (permits) is vacuous.** `grantPermit` / `consumePermit` / `revokePermit` / `expirePermits` have zero call sites in `src/` — only their definitions in `src/store/permits.js` and a re-export in `src/store/index.js`. `permit:administer` and `retention:approve` sit in `SCOPES` (`src/store/capabilities.js:17,19`) and are **behind no route** (nothing in `src/` reads either literal outside that list and one policy comment). They are *not* absent from every role allowlist: `ROLE_SCOPES.operator` is `[...SCOPES]` (`src/authority/policy.js:44`), so a live operator credential holds both — `collabcast whoami` prints them. What no role reaches them through is delegation: `root`, `goal_hub` and `listener` all exclude them by construction (`policy.js:45-66`). The mechanism is correct and unit-tested. Describe it as *implemented and unit-tested, not wired* — never as *enforced*.

**Open items, none started:**
- P1 as above (event log, replay, listener lease/epoch/fencing, durable Paseo acceptance before ack).
- `docs/api.md` and `docs/architecture.md` were rewritten against the real v0.3 surface, but nothing tests documentation, so treat both as unverified.
- Non-blocking note from the security re-review: add one e2e assertion that reads `collabcast_enroll`'s advertised schema from a live `tools/list` and checks `required` and `role.enum`, so the schema fix has behavioural cover as well as static cover.
- `retention.*` (prune, rollback, snapshots) is vocabulary only — `PERMIT_OPERATIONS` (`src/store/permits.js:13`), the approval `kind` CHECK (`src/store/schema.sql:64`, allowing `enrollment`/`prune`/`rollback`/`scope_widen`), `event.pruned_at` (`schema.sql:105`), config knobs, and `assertPathExcluded` (`src/config/load.js:131`) whose only callers are tests. No code removes a message today.

**Ungated operator actions, not to be taken by an agent:** npm publish (the name `collabcast` is free — `npm view collabcast` returns `E404`, re-checked while auditing this file), GitHub repo rename, the local directory rename plus Paseo re-registration (**sequence this last** — this worktree's `git-common-dir` points into that checkout's `.git`), and the `.walkie-talkie/` → `.collabcast/` live-state migration. Nothing outside this worktree has been touched; `/Users/trev/Projects/development/omp-workflow` is owned by another session and is read-only here without an explicit reservation.

---

## Hard-won lessons — six defects came from one mistake

**A fixture that constructs the subject cannot detect the subject failing to construct itself.** This produced the worst defects in the project, repeatedly:

1. `startService()` never started the authority socket — the test fixture built it. 854 tests green while no client could obtain a first capability. The product could not bootstrap at all. (The number is recorded in the tree: `test/helpers/stack.js:268`.)
2. Nothing in `src/` ever wrote `operator.cred` — two test helpers wrote it. 1,142 tests green over a completely unusable operator CLI, including `enroll --recovery`, the break-glass path, locked out by the condition it exists to recover from. (Recorded at `test/e2e/fresh-install.test.js:5`; commit `e0d7824` reports that suite as "95 files / 1142 tests".)
3. A rename pass changed strings inside `hooks/scripts/check-inbox.sh` without ever running it, so the packaged hook was dead on **every** invocation and could not report it.

**Consequence for any new work:** if the product is supposed to create an artifact, the test must let the product create it. If a test would still pass with your production change deleted, it is worthless — prove each fix red by deleting only the production change (copy the file to a temp path and back; `git stash` reverts to v0.2 and proves nothing).

**Corollary that bit three times: never write a probe whose failure mode is a false green.** An 8-iteration hammer over `test/e2e/` once reported all-green in 7 seconds, when a single real full run cannot finish anywhere near that fast — the filter matched nothing and the grep-based pass check reported success. (A full run measured ~25–32s wall on this machine while auditing this file; the "17s" an earlier draft quoted is stale, and the exact figure is not the point.) Assert the expected test count in any loop, so a vacuous run cannot pass.

**Related class: a test asserting a path production cannot reach.** Two dead-registry tests pinned P0-*violating* behaviour as correct (alias takeover; a rejected `invitedBy` field), and a third injected a synthetic `permit_required` into a publish mock after the per-post gate was deleted. All were green. A test pinning removed semantics is worse than a missing test — the regression channel inverts.

**And: a guard that reports clean by construction.** `FIXTURE_PREFIXES` covered 2 of the suite's ~30 `mkdtemp` prefixes, hiding a real per-run directory leak. Leak detection now keys on a stamp written by `createFixtureDir`, so coverage is structural. (Reasoning and the ratio are preserved at `test/helpers/fixture-leaks.js:14-19`, which says "~30"; an earlier draft of this file said "33", which nothing substantiates.)

---

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
export COLLABCAST_HOME=/tmp/cc-smoke-home      # or init writes the REAL ~/.collabcast/identities.json
mkdir -p /tmp/collabcast-smoke && cd /tmp/collabcast-smoke && git init -q
node /path/to/repo/bin/collabcast.js init --mode standalone   # operator inferred from git config user.name
node /path/to/repo/bin/collabcast.js start
node /path/to/repo/bin/collabcast.js whoami
node /path/to/repo/bin/collabcast.js talk "hello"
node /path/to/repo/bin/collabcast.js status
node /path/to/repo/bin/collabcast.js stop
```

Verified behaviour of that sequence, re-run against this tree: `init` scaffolds `.collabcast/{channel.md,config.json,logs,.sessions}`, adds `.collabcast/` to `.gitignore`, and registers the namespace in `$COLLABCAST_HOME/.collabcast/identities.json`. It does **not** create the store — `.collabcast/store/collabcast.db` (plus `-wal`/`-shm`) is created by `start`, which is what the boot order below means by "store first". `start` also binds `run/collabcast.sock` and `run/authority.sock` and mints `run/{hook.secret,operator.cred}`, all `0600` under a `0700` `run/`. `status` reports pid, mode and schema version (`Service for proj is answering (pid N), mode standalone, schema 6`). `whoami` prints principal, role `operator` and all ten scopes; `talk` returns the new ULID.

Every command past `init` authenticates with `.collabcast/run/operator.cred` (mode `0600`), which `start` mints — see `src/authority/operator-credential.js`. `test/e2e/fresh-install.test.js` drives exactly this through the shipped CLI.

CLI exit codes let a hook or script branch without scraping stderr: `0` ok, `1` error, `2` denied (`unauthenticated`, `forbidden`, `not_owner`, `wrong_namespace`, `scope_required`, `permit_required`, `permit_invalid`, `conflict`, `not_found`), `3` service unavailable. See `EXIT_*` (`src/cli/index.js:34-37`) and `DENIED_CODES` (`:39-49`); the denied set is exactly those nine codes, and `unavailable` is mapped ahead of them (`:54`). Verified: with the service stopped, `talk` and `whoami` exit `3`. **`status` is the exception** — it *reports* an unreachable service and still exits `0`, so branch on its output, never on its code.

---

## The single-writer invariant (load-bearing)

`.collabcast/channel.md` is the source of truth. **`src/core/channel.js` is the only path that writes it**, using `proper-lockfile` plus POSIX atomic rename. Every other surface goes through the service's HTTP API; the service process is the only caller of `channel.js` write paths.

This gives multi-writer correctness without a central coordinator. Bypassing it (e.g. having the MCP server import `channel.js` directly) breaks the lockfile model and corrupts the file under concurrent writes.

**Rule:** new code that mutates `channel.md` goes through `POST /channel/message`, `PATCH /channel/message/:id`, or `POST /channel/message/:id/archive`. No exception.

Channel writes queue in front of the file lock, and lock contention surfaces as a retryable `503` (`busy`) rather than an opaque `500` (`src/core/channel.js:155,164`). Before that fix, a 40-way concurrent post measured `{201:21, 500:19}` — nineteen valid messages dropped with no signal that retrying was correct. That distribution was measured once during the v0.3 cutover and is **not reproducible from this tree**; the commit records only the `503`-not-`500` change. Trust the lesson, not the digits.

---

## Architecture: three surfaces, one service

```
src/core/         — channel, format, ids, mentions, git, history, time, validate
src/store/        — SQLite authority store; schema.sql is the shape of record
  principals.js    — the roster (roles: root, goal_hub, listener, operator, legacy)
  capabilities.js  — issue / verify / revoke; SCOPES is the scope vocabulary
  cursors.js       — per-principal read + ack marks, one pair per inbox view
  audit.js         — append-only decision log; redacts token/secret/credential values
src/identity/     — namespace resolution, host identity map, path canonicalisation,
                    and errors.js — the ONE error vocabulary (ERROR_CODES)
src/config/       — schema.js holds every product default; load.js validates
src/authority/    — operator-approval enrollment (hook socket, policy, secret, paths)
  operator-credential.js — mints/validates run/operator.cred in the composition root
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
  index.js         — Server setup, request handlers, transport; SERVER_NAME/SERVER_VERSION
  project.js       — findProjectRoot (env COLLABCAST_PROJECT_ROOT or walk up)
  capability.js    — in-memory capability holder; enrollment-code handling
  tools.js         — 10 collabcast_* tool handlers (the `SCHEMAS` keys, src/mcp-server/tools.js:62-195;
                     mirrored by TOOL_NAMES in test/helpers/mock-mcp-client.js:17-28)
  resources.js     — 3 collabcast:// resources (channel/recent, channel/inbox, sessions/active);
                     channel/inbox is subscribable via SSE
skills/collabcast/SKILL.md   — scenario-driven LLM prompt
hooks/            — SessionStart + UserPromptSubmit
commands/         — /collabcast-inbox and /collabcast-talk slash commands
omp-extension/    — the OMP approval hook that turns an operator click into an enrollment code
templates/channel.md — scaffold read by src/cli/init.js
plugin.json + .mcp.json + .claude-plugin/marketplace.json — plugin manifests
```

Boot order in the composition root is deliberate: **store → hook secret → operator credential → authority socket → HTTP transport → pid → watcher** — written out in that order at `src/daemon/daemon-entry.js:98-99` and implemented by `startService` (`:119` onward; `ensureOperatorCredential` at `:207`). Readiness must imply the operator can act. `/health` answering while the authority could not issue anything was the single worst defect found in this project.

The CLI and the MCP server both reach the service over a Unix socket at `<runtimeRoot>/collabcast.sock`, where `runtimeRoot` defaults to `<projectRoot>/.collabcast/run`. Neither imports `src/core/channel.js` — the only importers are service-side (`daemon-entry.js`, `watcher.js`, `routes/channel.js`, `routes/inbox.js`); the one mention under `src/cli/` is a doc comment (`src/cli/init.js:73`), not an import. Precedence for `runtimeRoot`: explicit argument, then `COLLABCAST_RUNTIME_ROOT`, then the default (`src/daemon/transport.js:76-77`).

---

## Authority: capabilities, not permits

There is no per-post permission gate. A caller proves who it is with a capability presented as `Authorization: Bearer <token>`, and each route demands a named scope (`channel:read`, `channel:publish`, `channel:ack`, `self:alias`, `self:cursor`, `enroll:delegate`, …). `src/daemon/auth.js` is the whole boundary: `requireCapability` authenticates, `requireScope` authorizes.

Capabilities are minted two ways and no others:

1. **`POST /enroll/exchange`** — the only capability-*minting* route reachable without a credential, because it is how a caller with no credential gets one. It sits in the public router set that `server.js` mounts ahead of `requireCapability` (`src/daemon/server.js:247` then `:249`); the only other pre-auth handler is unauthenticated `GET /health` (`:232`), which mints nothing. It redeems a one-use, short-lived enrollment code that exists only because a human clicked Approve in the OMP hook dialog. Hook enrollment mints **`root` and nothing else** (`ENROLL_ROLE` / `ENROLLABLE_ROLES`, `src/authority/policy.js:22,25`). `goal_hub` and `listener` are *delegated*, never enrolled.
2. **`POST /delegate`** — a `root` **or `operator`** capability mints a narrower one (`DELEGATING_ROLES`, `src/daemon/routes/enroll.js:30`, enforced at `:93`). The *target* role may only be `goal_hub` or `listener` (`DELEGABLE_ROLES`, `:15`, enforced at `:101`). `issueCapability` enforces scope-subset and expiry-ceiling against the parent row, so a widened request is refused by the store rather than by a check a route could forget.

`operator` is a third thing: the human's break-glass identity, holding every scope the store defines (`ROLE_SCOPES.operator = [...SCOPES]`, `src/authority/policy.js:44`), **not** in `ENROLLABLE_ROLES` and not in `DELEGABLE_ROLES`, minted only by the service for the uid that owns the `0700` runtime directory.

**The operator credential is judged by what it grants, not by where it sits.** Reuse of an existing `run/operator.cred` verifies role is exactly `operator` (`src/authority/operator-credential.js:204`) **and** that its scopes cover the complete operator set (`:220-233`). Completeness is load-bearing: `issueCapability` refuses a child scope the parent lacks, so an operator credential missing `listener:consume` would make `enroll --recovery` appear to work and hand back a crippled capability. A credential it will not honour is **refused, never re-minted over** — silently replacing a revoked token would make `collabcast revoke` theatre. Recovery is `rm run/operator.cred` and restart, which requires the owning uid.

`src/store/permits.js` still exists as a store table, but nothing on the write path consults it. **Do not reintroduce a permit check on publish.** `permit_required` survives in exactly one real place: `collabcast_enroll` raises it when no operator approval injected a code (`src/mcp-server/tools.js:328-333`). Its three other occurrences are vocabulary, not enforcement — the `ERROR_CODES` list (`src/identity/errors.js:17`), the CLI's denied set (`src/cli/index.js:45`) and the HTTP status map (`src/daemon/server.js:46`).

---

## Message marker is the durable record

Every message in `channel.md` carries an HTML comment marker:

```
<!-- walkie:msg id=<ULID> type=<type> from=<principalId> from-tool=<tool> timestamp=<iso> mentions=<csv> [autonomous] -->
```

The Markdown heading above it is **rendered** from the marker, not the other way around. `parseMessage(block)` reads the marker and rebuilds the heading on edit/archive. All identity fields and git provenance round-trip; do not break this when extending the format. Bodies are additionally fenced by `<!-- walkie:body id=… -->` / `<!-- walkie:body-end id=… -->`. See `src/core/format.js`.

**Every value rendered into a block is escaped** via `headingText`, including the human-readable `**Time:**`, `**Git:**` and `**Edited:**` lines (`src/core/format.js:208`, `:213-214`, `:223`). Those three were once interpolated raw, and `git config --local user.email` genuinely stores embedded newlines — so a `.git/config` write made one benign authenticated post write **two** blocks, the second with an attacker-chosen `from=`, which `ownsMessage` then granted edit rights over. Independently, any git value containing a control character is discarded and returned as `null` before it can reach the renderer (`CONTROL_CHAR_RE`, `src/core/git.js:50`, applied at `:61`) — two layers on purpose: escaping keeps the file parseable, this keeps it honest.

`mentions` holds **principal ids**, plus the symbolic tokens `@all` and `@operator` (`MENTION_ALL` / `MENTION_OPERATOR`, `src/daemon/routes/support.js:93-94`; resolved by `resolveRosterMentions`, called from `src/daemon/routes/channel.js:191`). It never holds an alias — matching on aliases let a rename redirect another principal's directed traffic. Note that `src/core/mentions.js` still scans *body text* for `@alias` tokens; that is the authoring convenience, not what gets stored in the marker.

ULIDs order lexicographically by creation time, so `m.id > since` is valid and every cursor is a message id for exactly that reason. **A cursor is never an ordinal:** recomputing a position from whatever currently parses moved stored cursors past undelivered messages, permanently and silently. Cursor kinds are exactly four — `read`, `ack`, `read_with_memory`, `ack_with_memory` — with the view baked into the kind and one row per `(namespace, owner, kind)` (`src/store/schema.sql:140,143`). New ids are minted inside the channel write lock, floored on the highest id already in the file, so a backward clock step cannot mint below a live cursor. An unincrementable floor (a marker carrying `id=ZZZZ…Z`) is a named `conflict` naming the offending id — it used to be an unhandled throw that bricked every future post for every principal.

Prior revisions in `.sessions/<id>.history.md` are fenced the same way. Before that, `readHistory` truncated a revision at the first `\n\n---`, so an ordinary markdown horizontal rule silently discarded everything after it.

---

## Reads never mutate

`GET /inbox` and every MCP resource read are pure functions of (channel, cursors). Cursors move only through `POST /cursor/read` and `POST /cursor/ack`, always for the calling principal — there is no `:principalId` path parameter.

The two inbox views (`include_memory_updates` false / true) carry **separate cursor pairs**, and acking must pass the same flag the read passed. A scalar high-water mark is sound only over a set that cannot gain members below it; one cursor serving two differently-filtered views meant an ordinary ack stepped over any hidden `memory-update`, making it unreachable forever.

**Known residual, and a hard prerequisite on P1 retention:** a message that becomes parseable *after* a higher id was acked stays invisible. No scalar cursor can express this — it needs per-message delivery tracking, i.e. the P1 event log. `retention.rollback` **is** this case by construction, since restoring an older `channel.md` re-enters messages below existing cursors as normal operation. The event log must land before or with rollback.

---

## No hard delete

`collabcast archive <id>` is the strongest removal. Archives stay in the file (collapsed banner) and are excluded from default reads. This is a design constraint (accountability), not an oversight. Editing is authorship — only the author may change a body, operator included. Archiving is moderation — the author or an `operator`.

---

## Naming

The rename to collabcast deliberately did **not** move the on-disk marker prefix. `<!-- walkie:msg … -->`, `<!-- walkie:body … -->`, `<!-- walkie:body-end … -->`, `<!-- walkie:rev … -->`, `<!-- walkie:rev-end … -->`, `WALKIE:HEADER_END`, the `MARKER_*` / `WALKIE_COMMENT_RE` regexes in `src/core/{format,channel,validate,history}.js`, and `isValidMessageBody`'s rejection of the literal `<!-- walkie:` all stay. Reasons: the prefix is invisible to users, `isValidMessageBody`'s unforgeability argument is built on that exact literal, and renaming it forces a migration of a file that P1 turns into a generated projection anyway. **Do not "finish" this rename.** A "DELIBERATELY NOT RENAMED" retention comment sits at each of the four definition sites: `src/core/channel.js:14`, `src/core/format.js:14`, `src/core/history.js:34`, `src/core/validate.js:64`.

`test/helpers/isolation.js` `FORBIDDEN_ROOTS` lists **both** spellings (`~/.collabcast` and `~/.walkie-talkie`, and both checkout paths) on purpose — the operator's real pre-rename state still exists, and a guard that only knew the new names would stop protecting it. Do not remove either.

Everything user-facing did move: package and bins (`collabcast`, `collabcast-mcp`), MCP tools (`collabcast_*`), resource scheme (`collabcast://`), state directory (`.collabcast`), env vars (`COLLABCAST_*`).

---

## Known gaps

1. **The operator credential cannot be re-issued without filesystem access.** By design — see Authority. Recovery is `rm` plus restart. There is no `collabcast reissue`.
2. **SSE is best-effort.** `GET /events` replays nothing and survives no restart; a reconnecting subscriber can miss events. `EVENT_TYPES` (`src/daemon/routes/events.js:13-18`) now holds exactly **four**: `message.posted`, `message.edited`, `message.archived`, `channel.external_edit`. It is asserted against the real emitters by `test/daemon/routes/events.test.js`, so the list cannot drift silently. It previously advertised ten, six of them dead — that ratio is recorded in the test's own header comment (`test/daemon/routes/events.test.js:1`), and the six were deleted rather than implemented, which is why the live list is four.
3. **Channel-write audit rows are not transactional with the write.** A file rename cannot join a SQLite transaction, so `src/daemon/routes/channel.js` writes the file first and the audit row second. Ordering guarantees no fabricated rows, but a crash between the two loses one. Closing it needs a durable intent row in `src/core/channel.js`, not a change to the route.
4. **A lock held past `stale: 5000` can be stolen.** `proper-lockfile` refreshes mtime every `stale/2`, but the refresh is a timer and this process makes synchronous `better-sqlite3` calls on the same event loop. A >5s stall past a refresh would permit a lost update. Reasoned, never demonstrated.
5. **The `newIdAfter` floor is derived from the file.** If `channel.md` is emptied while store cursors survive, the floor vanishes and a backward clock step can mint below a live ack cursor. Nothing enforces file/store agreement.
6. **A roster subscription receives a spurious notification on every `message.posted`.**

---

## Reference docs

- **Architecture diagrams:** `docs/architecture.md`
- **API reference:** `docs/api.md` (HTTP routes + MCP tools/resources + marker schema)
- **Setup:** `docs/setup.md`
- **FAQ:** `docs/faq.md`

Both `api.md` and `architecture.md` were rewritten against the real v0.3 surface rather than renamed, because a rename pass over a stale document produces a correctly-branded lie. Nothing tests documentation, so verify against `src/` before relying on either.

---

## Test helpers worth knowing

- `test/helpers/isolation.js` — loaded as a vitest `setupFile`; **throws before any test body runs** if the process could reach live user state. `REQUIRED_ROOT_ENV` must all name disposable paths. Never work around it.
- `test/helpers/global-setup.js` — builds the per-run disposable tree and exports the `COLLABCAST_*` / `GIT_CONFIG_*` variables.
- `test/helpers/fixture-leaks.js` — **`createFixtureDir(prefix)` is the only sanctioned way to make a fixture root** (`:51`). It mkdtemps *and* stamps, so leak detection sees it by construction (detection keys on the stamp, `:78-84`). `test/helpers/fixture-leaks.test.js` fails the run and names your `file:line` if a raw `mkdtemp` appears under `test/` (`:118-138`); exactly three files are allowlisted, each with a stated reason — `helpers/fixture-leaks.js`, `helpers/isolation.js`, `security/init-injection.test.js` (`RAW_MKDTEMP_ALLOWED`, `:97-101`, reasons at `:86-96`).
- `test/helpers/registered-namespace.js` — `createRegisteredNamespace({ namespace, mode, config })`; gives a registered namespace, a `runtimeRoot`, and `writeOperatorCredential()`.
- `test/helpers/stack.js` — `createStack({ mode, namespace, operator })` stands up store + authority + server; `socketRequest()` speaks HTTP over the Unix socket.
- `test/helpers/spawn-daemon.js`, `spawn-mcp.js` (`MCP_BIN` → `bin/collabcast-mcp.js`), `mock-mcp-client.js` (`TOOL_NAMES` is the asserted tool inventory), `tmp-project.js`.
- `test/helpers/loopback-binding.test.js` — guards `installLoopbackBinding()`, which rewrites every hostless port bind in the test process to `127.0.0.1`. Without it, a wildcard `listen(0)` collides with foreign loopback listeners on this machine and a **stranger's server answers your test's request** — the test proves exactly that, twice (`:80`, `:97`), and the header records eleven foreign loopback-only listeners measured on this machine (`:16`). The "5 of 15 full runs red before, 0 of 32 after" figures come from the session that added the guard; they are not derivable from the tree, so treat them as the motivation, not as a check you can re-run.

**Trap that cost a full round of P0 evidence:** the harness exports a **single `COLLABCAST_SOCKET_PATH` for the whole run** (`test/helpers/isolation.js:170`) and propagates it into spawned children (`:235`), and an explicit socket path **overrides** the one derived from `COLLABCAST_RUNTIME_ROOT` (`src/daemon/transport.js:85-88`; the documented precedence is at `:76-77`). So a test that gives each project its own `COLLABCAST_RUNTIME_ROOT` still shares one socket unless it also clears `COLLABCAST_SOCKET_PATH: undefined` — three files do exactly that today (`test/daemon/lifecycle.test.js`, `test/e2e/fresh-install.test.js`, `test/e2e/packaged-hook.test.js`). Symptom: one project's daemon answers another's `status`, `startDaemon` takes its `if (current.running) return current` short-circuit, and `start` exits `0` **without booting** — so whatever the boot was supposed to validate is never validated. It went unnoticed at 1 red in 12 full runs (recorded in commit `a1fa688`'s message). `readHealth`'s namespace guard cannot catch it when both projects use the same namespace. **If your test owns a runtime root, clear the socket path too.**

---

## Conventions

- ES modules, Node ≥ 22.
- Vitest + supertest for tests; do not introduce alternatives.
- Commit messages: `type(scope): subject` in the imperative (`feat`, `fix`, `docs`, `chore`, `test`, `refactor`).
- **Every product default lives in `src/config/schema.js`.** Import `DEFAULT_CONFIG` or its helpers rather than repeating a literal.
- **Every error is a `CollabcastError` with a code from `ERROR_CODES`** (`src/identity/errors.js`). An unlisted code throws at construction so it cannot reach a client. Never put a token, a secret, or a credential path into `message` or `detail` — the operator-facing report may name a path, the wire envelope may not.
- **Duplication is fine; unasserted duplication is not.** A value copied across files needs a test proving the copies agree. `SCHEMA_VERSION` was pinned as a bare literal twice and said nothing about the property under test; `SERVER_VERSION` drifted to `0.3.0` while `package.json` said `0.2.0` with nothing catching it. `test/packaging/identity.test.js` now asserts version agreement across all four declarations, that `files`/`bin` targets resolve, and that no metadata still advertises a single-harness product.
- Tests that need a namespace use `createRegisteredNamespace` or `createStack`, not hand-built directories.
- `test/scratch/**` is excluded from the suite by `vitest.config.js`. Put throwaway probes there or in `/tmp`, never under a collected `test/` path. Explicit on-demand runs of an excluded file are impossible in vitest 1.6, so a second config exists for that.
