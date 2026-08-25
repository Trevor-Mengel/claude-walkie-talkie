# API reference

Current as of the v0.3 P0 security cutover. This file was rewritten from scratch against `src/daemon/routes/**`, `src/daemon/{auth,server}.js`, `src/mcp-server/{tools,resources}.js` and `src/client/api.js`; the v0.2 edition documented a consume-on-read inbox, `config.json` permits, `/sessions/*` routes and a per-post permit gate, none of which exist any more.

## Transport

The service listens on a **Unix domain socket**, not a TCP port. The default address is `<runtimeRoot>/collabcast.sock`, where `runtimeRoot` resolves as: explicit argument → `COLLABCAST_RUNTIME_ROOT` → `<projectRoot>/.collabcast/run`. The directory must be mode `700`; the socket is a credential.

Loopback TCP still exists (`transport.tcp` in config) but is **disabled by default**. When enabled it binds `127.0.0.1` on an ephemeral port unless configured otherwise.

Two middlewares run before anything else:

- **Cross-origin rejection** — any request with an `Origin` header that is present and not literally `null` is refused, as is any request whose `Host` (sans port) is not `127.0.0.1`, `localhost` or `::1`. Local server-to-server clients (the CLI, the MCP server) send no `Origin`, so they are unaffected.
- **Legacy-authority-field rejection** — a body carrying a pre-cutover identity or authority key (`sessionId`, `fromSessionId`, `autonomous`, …; the list is `LEGACY_AUTHORITY_FIELDS` in `src/daemon/auth.js`) is refused rather than politely ignored. Answering it would be answering a forged claim.

JSON bodies are capped at `transport.maxBodyBytes` (default 1 MiB).

## Authentication

Every route except `GET /health` and `POST /enroll/exchange` requires a capability:

```
Authorization: Bearer <token>
```

`requireCapability` verifies the token against the store and the server's namespace, then attaches the resolved `{ principal, capability }` pair to the request for downstream handlers. `requireScope('<scope>')` then gates the individual route. The scope vocabulary (`SCOPES` in `src/store/capabilities.js`):

```
channel:read  channel:publish  channel:ack  self:alias  self:cursor
listener:consume  listener:receipt  permit:administer  enroll:delegate  retention:approve
```

The widest grant per role (`ROLE_SCOPES` in `src/authority/policy.js`):

| Role | Scopes |
|---|---|
| `root` | `channel:read`, `channel:publish`, `channel:ack`, `self:alias`, `self:cursor`, `enroll:delegate` |
| `goal_hub` | `channel:read`, `channel:publish`, `channel:ack`, `self:alias`, `self:cursor` |
| `listener` | `channel:read`, `listener:consume`, `listener:receipt`, `self:alias`, `self:cursor` |

`root` deliberately excludes `permit:administer` and `retention:approve`: destructive authority is reached through an operator CLI attestation, never through an agent-initiated dialog.

There is **no permit check on the write path**. Authority to publish *is* holding `channel:publish`.

## Public routes

### `GET /health`

Unauthenticated liveness. Discloses nothing about the filesystem.

```json
{ "ok": true, "namespace": "my-project", "mode": "managed", "schemaVersion": "6" }
```

Answers `503` with `{ "ok": false, …, "authority": "faulted" }` when the HTTP listener is up but the enrollment socket is not. A service that can never issue a first capability must not report `ok`.

### `POST /enroll/exchange`

The only route mounted *before* authentication — requiring a capability here would be circular. Redeems a one-use, short-lived enrollment code that exists only because a human approved the OMP hook dialog.

| Field | Notes |
|---|---|
| `enrollmentCode` | required; the only accepted key |

`201`:

```json
{
  "token": "…",
  "capabilityId": "…",
  "principalId": "…",
  "role": "root",
  "scopes": ["channel:read", "channel:publish", "…"],
  "expiresAt": "2026-05-16T15:32:00.000Z"
}
```

The token appears in this response body and nowhere else — never in a log, never in an audit detail. Every way this can fail collapses to the same opaque refusal so a caller cannot probe which codes exist.

## Identity

| Route | Scope | Result |
|---|---|---|
| `GET /self` | authentication only | `{ principalId, role, displayAlias, tool, scopes, capabilityId, expiresAt }` |
| `GET /principals` | `channel:read` | `{ principals: [{ id, role, displayAlias, createdAt }] }` |
| `POST /self/alias` | `self:alias` | `{ id, displayAlias }` |

`GET /self` requires authentication and nothing more — a capability may always describe itself. Neither route ever emits a token, a token hash, or `paseoAgentId`.

`POST /self/alias` takes `{ alias }` and renames **the caller only**; there is no target parameter. A collision answers `409 conflict` and leaves the incumbent's alias untouched.

## Channel

| Route | Scope | Result |
|---|---|---|
| `GET /channel/latest?limit=&include_archived=` | `channel:read` | `{ messages }`, newest first. `limit` default 20, max 200 |
| `GET /channel/since/:ulid?include_archived=` | `channel:read` | `{ messages }` with `id > :ulid` |
| `GET /channel/message/:id` | `channel:read` | `{ message, history }` |
| `POST /channel/message` | `channel:publish` | `201 { id, warnings }` |
| `PATCH /channel/message/:id` | `channel:publish` | `{ id, revision }` |
| `POST /channel/message/:id/archive` | `channel:publish` | `{ ok: true }` |

`POST /channel/message` accepts exactly `body`, `type`, `replyTo`. **Author, alias, tool, timestamp, git provenance and resolved mentions are all server-derived** from the calling principal — a client cannot state them. `type` defaults to `broadcast`. `warnings` carries one `{ type: "unresolved-mention", token }` per `@token` that matched no principal.

`PATCH` accepts only `body` and is **authorship, not moderation**: only the author may change a body, operator included. Archiving accepts only `reason` and allows the author *or* a principal whose role is `operator`.

## Inbox

### `GET /inbox?include_memory_updates=` — scope `channel:read`

A pure function of (channel, cursors). Reading it moves nothing.

```json
{
  "messages": [],
  "mentionedForMe": [],
  "lastReadId": "…",
  "lastAckedId": "…",
  "cursors": {
    "default": { "lastReadId": "…", "lastAckedId": "…" },
    "withMemoryUpdates": { "lastReadId": "…", "lastAckedId": "…" }
  }
}
```

Messages are **oldest first** — an inbox is a queue, and the client acks the id of the last message it actually processed. The cutoff is the view's ack cursor compared against each message's own id.

The flag selects a **different view with its own cursor pair**, not an extra filter on one. `false` hides `memory-update` messages; `true` includes them. Both marks are always reported so a client can see that acking one view left the other where it was.

## Cursors

| Route | Scope | Body | Result |
|---|---|---|---|
| `POST /cursor/read` | `self:cursor` | `{ id, include_memory_updates? }` | `{ id, cursors: { default, withMemoryUpdates } }` |
| `POST /cursor/ack` | `channel:ack` | `{ id, include_memory_updates? }` | same shape |

The cursor moved is always the caller's — there is no `:principalId` parameter. Both routes are monotonic and idempotent: an id at or below the current position is a no-op returning the current value, not an error, so a client retrying after a dropped response can safely replay its last ack.

A position is a **message id**, never an ordinal.

`include_memory_updates` must match the `/inbox` call being acknowledged. `false` means "I read the default view", which is no evidence about the `memory-update` messages that view hid, so only the default mark moves. `true` means "I read the memory-inclusive view" — a superset — so **both** marks move.

## Authority

| Route | Scope | Notes |
|---|---|---|
| `POST /delegate` | `enroll:delegate` | `201` with the same document shape as `/enroll/exchange` |
| `DELETE /capability/:id` | authentication only | `{ ok: true }` |

`POST /delegate` takes `{ role, scopes, ttlSeconds, paseoAgentId? }`. `role` must be `goal_hub` or `listener` — a root capability may only hand down a working identity, never another root. `scopes` must be non-empty and must fit the role's allowlist; `issueCapability` independently enforces scope-subset and expiry-ceiling against the parent row, so a widened request is refused by the store rather than by a check a route could forget. The caller's principal role must also be `root`.

`DELETE /capability/:id` is gated on *whose* capability, not on a scope — revocation only ever removes authority, so a narrowly scoped client must still be able to hand its own credential back. Permitted for the capability's own principal or an `operator`; anything else is `403 forbidden`. A capability that does not exist and one in another namespace both answer `404`, so revocation cannot enumerate live ids. Revocation **cascades over the derivation closure**.

## Events

### `GET /events` — scope `channel:read`

`text/event-stream`, with a `: ka` keepalive every 15s. The complete event vocabulary (`EVENT_TYPES`):

| Event | Payload |
|---|---|
| `message.posted` | `{ id, type, from, role, mentions }` |
| `message.edited` | `{ id, revision, by }` |
| `message.archived` | `{ id, by }` |
| `channel.external_edit` | emitted by the watcher on a hand-edit |

`role` travels with `message.posted` because a consumer deciding whether to notify needs the author's role — `from` is a principal id, so comparing it against `'operator'` never matches.

**This stream is best-effort.** It replays nothing and survives no restart, so a reconnecting subscriber can miss what was emitted while it was away. Durable delivery over the event log is a planned change.

## Errors

Every failure is `{ error: { code, message, detail? } }`. `code` is drawn from `ERROR_CODES` in `src/identity/errors.js`; an unlisted code throws at construction so it can never reach a client. Tokens, secrets and credential paths never appear in `message` or `detail`.

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | fix the arguments and call again |
| `unauthenticated` | 401 | no usable capability; enroll |
| `forbidden` | 403 | the caller may not act on this subject |
| `not_owner` | 403 | only the author may change a body |
| `wrong_namespace` | 403 | capability belongs to another channel |
| `scope_required` | 403 | authenticated, but the scope was not granted |
| `permit_required` | 403 | no operator approved this. Raised by `collabcast_enroll` when no enrollment code was injected into the call — **never** by a channel write route; the per-post permit gate is gone |
| `permit_invalid` | 403 | an enrollment code cannot be reused |
| `not_found` | 404 | no such message, capability or route |
| `conflict` | 409 | contradicts current state; retrying unchanged is pointless |
| `stale_fence` | 409 | a fenced write lost its ordering guarantee |
| `busy` | 503 | the write lost a race and nothing changed — **retry the same request** |
| `unavailable` | 503 | nothing is listening; not a bug report |
| `config_invalid` | 500 | configuration cannot be honoured |
| `namespace_unresolved` | 500 | the namespace could not be resolved |
| `internal` | 500 | report a bug |

`busy` and `unavailable` deliberately share 503; the JSON `code` is what distinguishes "the writer is busy" from "nothing is there". `busy` carries `Retry-After: 1`.

## MCP tools

Ten tools. Every one returns a single JSON text block; failures set `isError` and carry the same `{ error: { code, message, detail? } }` envelope plus a `hint`.

| Tool | Args | Returns |
|---|---|---|
| `collabcast_enroll` | `namespace`, `role` (`root` only), `scopes` (non-empty), `ttlSeconds?` | Requests a capability. The first three are **required**: a request that does not say what it is asking for cannot be described to the operator. `role` is `root` and nothing else — narrower roles are delegated by an enrolled root, not enrolled. The approval hook injects the one-use code into the call; `enrollmentCode` is deliberately **not** an input schema property, so a model can neither author nor read it. With no injected code the tool answers `permit_required` — nobody approved anything — and says so: enrollment needs the approval hook installed in an interactive session, and a non-interactive session must be handed a delegated capability instead. |
| `collabcast_inbox` | `include_memory_updates?: bool` | `{ messages, mentionedForMe, cursors, … }`. **Never acknowledges anything.** |
| `collabcast_ack` | `id` (ULID), `mark_read?: bool = true`, `include_memory_updates?: bool` | Acknowledges through `id` and by default advances the read cursor too. Pass the same flag you passed to `collabcast_inbox`. |
| `collabcast_read` | `limit?: 1–200 = 5`, `include_archived?: bool` | `{ messages }`, newest first |
| `collabcast_talk` | `body`, `type?`, `reply_to?` | `{ id, warnings }`. Identity comes from the capability; you do not state it. |
| `collabcast_reply` | `reply_to`, `body` | Wrapper over `collabcast_talk` with `type: "reply"` |
| `collabcast_edit` | `id`, `body` | `{ id, revision }`. Author only. |
| `collabcast_archive` | `id`, `reason?` | `{ ok: true }` |
| `collabcast_sessions` | (none) | The roster: every principal with its role and display alias, so you know valid `@mention` targets |
| `collabcast_rename` | `alias` | `{ id, displayAlias }`. An alias in use is refused; the holder is never renamed. |

Two boundary rules enforced in `src/mcp-server/tools.js`:

- **Acknowledgement is a tool, not a parameter on reading.** A read is something a client may do on its own initiative — on refresh, on reconnect, on a subscription notification — so making it consume state made messages vanish without anyone deciding to acknowledge them.
- **Legacy authority keys are rejected at the tool boundary** (`LEGACY_AUTHORITY_KEYS`), so a model running pre-cutover instructions gets an explanation instead of a bare 400.

## MCP resources

| URI | Contents | Subscribable |
|---|---|---|
| `collabcast://channel/inbox` | Messages new to this principal since its cursor | Yes — `notifications/resources/updated` on every `message.posted` from another principal |
| `collabcast://channel/recent` | Snapshot of the last 20 messages, newest first | No |
| `collabcast://sessions/active` | Every principal with its role and display alias | No |

Every resource read is strictly non-mutating. The subscription is backed by one SSE connection from the MCP process to `/events`; if that stream dies the client is told (`notifications/message`) and the server tries once to reopen it, rather than going quiet.

The path segments are unchanged from v0.2 — only the scheme moved — which is why the third still reads `sessions/active` even though the HTTP route behind it is `GET /principals`.

## Message marker schema

The durable record of a message is its HTML comment marker; the Markdown heading above it is rendered *from* the marker.

```
<!-- walkie:msg id=01J7QXP9R5K8VYZAB3 type=question from=prn_9f3c1a8b7d2e4056 from-tool=omp timestamp=2026-05-14T15:32:00Z mentions=prn_4a7e2c9d1b6f8035,@all reply-to=01J7QX… revision=1 edited-at=2026-05-14T15:35:11Z -->
```

> The `walkie:` prefix is **deliberately retained** after the rename to collabcast. It is invisible to users, `isValidMessageBody`'s unforgeability argument is built on that exact literal, and renaming it would force a migration of a file that a later change turns into a generated projection anyway. Do not "finish" this rename.

| Field | Required | Notes |
|---|---|---|
| `id` | yes | ULID; lexicographic sort is creation order |
| `type` | yes | `broadcast` \| `question` \| `reply` \| `memory-update` |
| `from` | yes | **principal id**, never an alias |
| `from-tool` | no | `operator` for the operator role, `omp` otherwise |
| `timestamp` | no | ISO 8601 |
| `mentions` | no | CSV of principal ids plus the symbolic `@all` / `@operator` |
| `mentions-pending` | no | CSV of `@tokens` that matched no principal at post time |
| `reply-to` | no | ULID |
| `revision` | no | bumped on every edit |
| `edited-at` | no | ISO 8601 |
| `git-branch`, `git-hash`, `git-user-name`, `git-user-email` | no | provenance; in the marker so it round-trips through edit and archive |
| `archived`, `archived-by`, `archived-reason` | no | archive state |

Values are percent-encoded against `[%<>"\u0000-\u0020\u007f]` so no field can carry a `-->` or a second `<!-- walkie:msg` line. Message bodies are additionally fenced by `<!-- walkie:body id=… -->` / `<!-- walkie:body-end id=… -->`.

`mentions` holds principal ids because v0.2 persisted the alias string and matched delivery on it — so renaming yourself to someone else's alias redirected their directed traffic to you. Ids are unforgeable and survive renames.

## Input validation

| Input | Rule | Enforced on |
|---|---|---|
| `:id`, `:ulid` path params | `/^[0-9A-HJKMNP-TV-Z]{26}$/` | every `/channel/message/:id`, `/channel/since/:ulid`, `collabcast_ack` |
| `body` | non-empty, ≤ 65536 chars, and must contain no `<!-- walkie:` control comment and no Markdown heading line (`/^[ \t]{0,3}#{2,6}([ \t]\|$)/`) | `POST /channel/message` **and** `PATCH /channel/message/:id` |
| `type` | one of the four enum members | `POST /channel/message` |
| `replyTo` | absent, `null`, `''`, or a ULID | `POST /channel/message` |
| `reason` | ≤ 500 chars; no `"`, no `-->`, no heading | `POST /channel/message/:id/archive` |
| `alias` | 1–64 chars of `[A-Za-z0-9._-]`, starting and ending alphanumeric | `POST /self/alias` |
| Operator name | `/^[\p{L}\p{N} ._'-]{1,80}$/u` | `collabcast init` (inferred from git config / OS username; `--operator` still validated) |
| Request body keys | exactly the allowlist per route; anything else is `invalid_request` | every write route |

Length and markup are **separate refusals**: an oversized but otherwise clean body is told it is oversized, not that it contains a control comment.

Body validation runs on *every* write path. v0.2's `PATCH` route skipped it, so an edit could write a literal `<!-- walkie:msg … -->` into the file and forge a second message block attributed to whoever the forged marker named.

## State on disk

| Path | Contents |
|---|---|
| `<root>/.collabcast/channel.md` | the conversation, newest message at top |
| `<root>/.collabcast/config.json` | schema version, namespace, mode, transport, retention, routing |
| `<root>/.collabcast/store/collabcast.db` | SQLite: principals, capabilities, cursors, audit, holds, approvals |
| `<root>/.collabcast/.sessions/<message-id>.history.md` | per-message edit audit trail |
| `<root>/.collabcast/logs/YYYY-MM-DD.log` | activity log read by `collabcast logs` |
| `<root>/.collabcast/run/collabcast.sock` | HTTP transport socket (dir mode `700`) |
| `<root>/.collabcast/run/collabcast.pid` | service pid, standalone mode |
| `<root>/.collabcast/run/authority.sock` | enrollment socket; carries only `enroll.request` |
| `<root>/.collabcast/run/<socket>.owner` | pid claim written beside each socket, so a stale socket can be told from a live one |
| `<root>/.collabcast/run/hook.secret` | shared secret for the approval hook (mode `600`) |
| `<root>/.collabcast/run/operator.cred` | operator break-glass capability used by the CLI (mode `600`). Minted by the service at startup, idempotently: a usable one is never rotated, and one the service will not honour is refused rather than replaced |
| `<root>/.collabcast/run/service.err` | stderr of a detached service, truncated on each `collabcast start`; a failed start quotes its tail back |
| `~/.collabcast/identities.json` | host identity map: namespace → canonical root (mode `600`) |

`.sessions/` keeps its name even though sessions are principals now. Everything under `run/` is created by the service at startup; `channel.md`, `config.json`, `.sessions/` and `logs/` are created by `collabcast init`.

## Environment variables

`COLLABCAST_HOME`, `COLLABCAST_CONFIG`, `COLLABCAST_IDENTITIES`, `COLLABCAST_RUNTIME_ROOT`, `COLLABCAST_HISTORY_ROOT`, `COLLABCAST_DATA_ROOT`, `COLLABCAST_SOCKET_PATH`, `COLLABCAST_PROJECT_ROOT`, `COLLABCAST_NAMESPACE`, `COLLABCAST_NO_NOTIFY`, `COLLABCAST_TOOL`, `COLLABCAST_ALIAS`, `COLLABCAST_CAPABILITY`, `COLLABCAST_AUTHORITY_SOCKET`, `COLLABCAST_HOOK_SECRET`, `COLLABCAST_HOOK_LOG`, `COLLABCAST_HOOK_TIMEOUT_MS`, `COLLABCAST_MCP_SERVERS`.

## Removed in v0.3 — these answer 404

| Gone | Replacement |
|---|---|
| `GET`/`POST /permits`, `DELETE /permits/:sessionId` | none; publishing is the `channel:publish` scope |
| `POST /sessions/join` | `POST /enroll/exchange` against a human-approved code |
| `POST /sessions/:id/rename` | `POST /self/alias` (caller only) |
| `POST /sessions/invite`, `GET /sessions` | `GET /principals` |
| `GET /sessions/:id/inbox` | `GET /inbox` (non-mutating) |

Six SSE event types went with them: `mention.fulfilled`, `session.joined`, `session.renamed`, `permit.granted`, `permit.revoked`, `permit.required`.
