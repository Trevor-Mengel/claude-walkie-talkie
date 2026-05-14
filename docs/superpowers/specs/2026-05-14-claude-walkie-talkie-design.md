# claude-walkie-talkie — Design Spec

**Date:** 2026-05-14
**Status:** Draft, awaiting operator review before plan handoff
**Author:** Trevor Mengel (via collaborative brainstorming with Claude)

---

## 1. Purpose

Build an open-source, MIT-licensed tool that enables asynchronous two-way messaging between concurrently running Claude Code and Claude Cowork sessions working on the same project. The human operator is a first-class participant. The metaphor is a walkie-talkie: each participant broadcasts; everyone hears; attention is directed by name.

This is **not** a sync tool or a single-source-of-truth merge system. It is a messaging system.

The motivating workflow: building a demo app in Claude Code while planning the corresponding presentation in Claude Cowork, without manually copy-pasting context between the two.

## 2. Mental model

The `.walkie-talkie/channel.md` file inside each project is the source of truth. Three surfaces talk to it; they share one library (`walkie-core`) that is the only path that writes the file:

```
                    ┌─────────────────────────────────────┐
                    │ .walkie-talkie/channel.md           │  source of truth
                    │  (+ .lock, .sessions/, logs/)       │
                    └─────────▲───────────────────────────┘
                              │ atomic append-at-top via walkie-core
        ┌─────────────────────┼─────────────────────┬──────────────┐
        │                     │                     │              │
   ┌────┴────┐         ┌──────┴───────┐       ┌─────┴──────┐  ┌────┴─────┐
   │ walkie  │         │ walkie-talkie│       │ MCP server │  │  daemon  │
   │  CLI    │         │   plugin     │       │            │  │          │
   │ (oper.) │         │ (Code+Cowork)│       │ (any agent)│  │ watcher  │
   └─────────┘         └──────┬───────┘       └────────────┘  │ + SSE    │
                              │                                │ + notif. │
                       SKILL.md (NL-driven)                    └──────────┘
                       hooks/hooks.json (Code)
                       commands/ (slash cmds)
                       mcp.json → MCP server
```

## 3. Implementation language

**Node.js**, distributed via `npm install -g claude-walkie-talkie`.

Rationale: Claude Code itself is Node-based, so every Claude Code user already has Node available. `chokidar` is the most battle-tested cross-platform file watcher. JSON-native config aligns with the rest of the Claude plugin ecosystem.

## 4. Repository layout (the published artifact)

A single Anthropic-style plugin. One install, both Code and Cowork.

```
claude-walkie-talkie/
├── README.md, LICENSE (MIT), CONTRIBUTING.md
├── package.json                     # bin: { walkie: "./bin/walkie.js" }
├── plugin.json                      # Anthropic plugin manifest
├── bin/walkie.js                    # operator CLI entry
├── src/
│   ├── core/
│   │   ├── channel.js               # atomic append, parse, lockfile
│   │   ├── ids.js                   # ULID generator
│   │   ├── mentions.js              # @mention parsing + resolution
│   │   └── git.js                   # git metadata helpers
│   ├── daemon/
│   │   ├── server.js                # HTTP + SSE + watcher
│   │   ├── lifecycle.js             # PID/port/spawn/stop
│   │   └── notify.js                # desktop notifications
│   ├── cli/                         # init, start, talk, read, permit, ...
│   └── mcp-server/
│       └── index.js                 # exposes channel as MCP tools + resources
├── skills/
│   └── walkie-talkie/SKILL.md       # auto-discovers in both Code and Cowork
├── hooks/
│   ├── hooks.json                   # SessionStart + UserPromptSubmit
│   └── scripts/check-inbox.sh
├── commands/
│   ├── walkie-inbox.md
│   └── walkie-talk.md
├── mcp.json                         # MCP server config consumed by both envs
├── templates/channel.md
├── examples/demo-while-presenting/
├── docs/{architecture.md,setup.md,api.md,faq.md}
└── test/
```

## 5. Per-project on-disk layout

```
.walkie-talkie/
├── channel.md                       # the thread (source of truth)
├── config.json                      # operator name, port, permits, defaults
├── .lock                            # proper-lockfile artifact
├── server.pid                       # daemon PID (when running)
├── server.port                      # daemon bound port (when running)
├── .sessions/
│   ├── active.json                  # active sessions registry
│   ├── invitations.json             # pending invitations
│   └── <message-id>.history.md      # per-message edit history (audit trail)
└── logs/YYYY-MM-DD.log              # daily rotated activity logs
```

A per-machine registry at `~/.walkie-talkie/registry.json` lists every walkie-enabled project, so `walkie status --all` can report on all running daemons without `cd`-ing around.

## 6. Channel file format

### 6.1 Header

```markdown
# Walkie-Talkie Channel: cloutdesk

**Operator:** Trevor Mengel
**Channel created:** 2026-05-14T15:00:00Z

## Active sessions

| Session ID  | Tool          | Alias           | Joined     | Last seen   |
|-------------|---------------|-----------------|------------|-------------|
| cs_abc123   | claude-code   | demo-builder    | 15:00:14Z  | 15:32:01Z   |
| cs_def456   | claude-code   | api-implementer | 15:18:02Z  | 15:31:48Z   |
| cw_xyz789   | claude-cowork | slide-designer  | 15:05:33Z  | 15:28:10Z   |

## Recent sessions
- cs_old999 — claude-code (was "demo-builder"), retired 14:30:11Z (alias taken over by cs_abc123)

<!-- WALKIE:HEADER_END -->

---
```

The `<!-- WALKIE:HEADER_END -->` HTML comment is the writer's insertion anchor. Everything above it is the header (rewritten in place on session-update events). Everything below is the message log, newest first.

**Session is the primary actor; the tool is a descriptor.** All identifiers, mentions, and permissions are keyed on the session, not the tool.

### 6.2 Message block

```markdown
## 📡 demo-builder → @slide-designer
<!-- walkie:msg id=01J7QXP9R5K8VYZAB3 type=question from=cs_abc123 mentions=slide-designer reply-to=01J7QX... -->
**Time:** 2026-05-14T15:32:00Z (2 minutes ago)
**Git:** main @ a3f2c1d (trevor@abstractlabs)

Hey — I just wired up the Stripe Connect webhook handler. The demo flow now supports refunds. Should the slide on payment flows mention this, or keep it scoped to the original happy path?

---
```

**Field semantics:**

- **Signature line** (always present, human-readable): tool emoji + posting alias (or session ID if no alias) + ` → ` + recipients (`@<alias>` mentions, `all`, or `@<tool>`). The signature is rendered from the marker comment at write time and re-rendered if an alias changes; the marker is the durable truth.
  - Emojis: 📡 claude-code, 🎨 claude-cowork, 👤 operator, ⚡ fallback for future tools.
- **Marker comment** (machine-readable, the durable record): `id`, `type`, `from=<session-id>` (always immutable — uses the session ID, not the alias), optional `mentions=` (resolved alias list at write time), optional `reply-to=`, optional `revision=`, optional `edited-at=`, optional `archived=`, optional `archived-by=`, optional `archived-reason=`, optional `[autonomous]` flag, optional `mentions-pending=`.
- **Time** (always): ISO 8601 UTC + relative "X ago" (computed at read time, not stored).
- **Git** (best-effort): branch, short hash, `git config user.email` if available; omitted if not.
- **Body**: arbitrary markdown.

**Message types** (lowercased, validated):
- `question`, `reply`, `broadcast`, `memory-update`, `session-join`, `session-rename`

### 6.3 Identifiers

ULIDs (e.g., `01J7QXP9R5K8VYZAB3`). Lexicographically sortable by creation time, collision-resistant, no central coordinator required. Lets multiple writers race without ID collisions.

## 7. Atomic append protocol (`walkie-core`)

Multi-writer correctness without a central server is the core technical primitive. Anyone reading mid-write either sees the old file or the fully-formed new one.

1. Acquire `.walkie-talkie/.lock` via `proper-lockfile`. Retry up to ~2 seconds with jittered backoff.
2. Read `channel.md` into memory; locate `<!-- WALKIE:HEADER_END -->`.
3. Generate a fresh ULID and format the new message block (signature line, marker comment, metadata, body, `---` separator).
4. Write `header + marker + "\n---\n\n" + new_block + remaining_body` to `channel.md.tmp.<ulid>`.
5. `fs.renameSync` `.tmp.<ulid>` → `channel.md` (POSIX atomic on same filesystem).
6. Release the lock.

The lockfile is necessary because read-then-write would otherwise be a TOCTOU race even with atomic rename.

The same primitive supports **edit** (in-place body rewrite with `revision=N edited-at=...`) and **archive** (`archived=true archived-at=... archived-by=... archived-reason=...`). Edits append the prior body to `.walkie-talkie/.sessions/<msg-id>.history.md` for full audit trail. **No hard delete, ever.**

## 8. Operator hand-edit policy

The watcher detects external edits (any change to `channel.md` not initiated by walkie-core within the prior ~100ms grace window) and emits a `channel.external_edit` SSE event with mtime and a short diff stat. The daemon does **not** attempt to parse hand-edited prose as a message. The supported way for the operator to post is `walkie talk` (or natural language inside an agent). Hand-edits are tolerated as an escape hatch.

## 9. Session lifecycle

**Joining is implicit.** The first time a session interacts with walkie (via skill, MCP, or CLI from that session's environment), the helper calls `walkie.join()` transparently. The system registers it with a generated alias (`code-1`, `code-2`, `cowork-1`, ...) and posts a `session-join` message.

**Renaming is the operator's only manual step.** `walkie rename <alias>` (run from within that session's terminal) or `walkie alias <session-id> <alias>` (from anywhere) sets a meaningful alias. Posts a `session-rename` message.

**There is no separate accept/confirm step.** Because the operator is the same human behind every session, fulfillment is just naming.

**Staleness:** sessions with no activity (no read or write) for 6 hours (configurable) are auto-moved to "Recent sessions" in the header. No leave event. A session that returns from staleness simply moves back into Active on its next interaction.

## 10. @mentions

Mentions are the only mechanism for directing attention. All messages are broadcasts; `@<token>` calls someone out.

**Syntax:**
- `@<alias>` — specific session
- `@<tool>` (e.g., `@claude-code`, `@claude-cowork`) — all sessions of a tool
- `@operator` — the human
- `@all` — everyone (implicit default when no mention present)

**Resolution:** `walkie-core` parses the body and resolves each `@<token>` against the active sessions registry. Resolved mentions are stored in the marker comment. Unresolvable tokens (typos, future joiners) stay as raw text in the body and trigger an `unresolved-mention` warning.

**Reception:** when a session reads new messages, the inbox tags messages where this session is mentioned. The Code-side hook output prepends a "📬 You were mentioned in N new message(s)" callout. Cowork's `walkie_inbox` MCP tool returns mentioned-for-me messages first.

**No retroactive linking** — except via the explicit invitation mechanism (§11). A regular `@unknown-alias` mention is just text, even if a session later joins with that alias.

## 11. Invitations (advisory reservations)

When a CLI post contains an unresolved `@<alias>`, the operator is prompted interactively:

```
⚠️  @codex-helper isn't in this channel.
   (i)nvite — reserve this alias for a future matching session
   (s)end as-is — post with raw text
   (e)dit / (c)ancel
> i
```

An invitation is a one-row record in `.walkie-talkie/.sessions/invitations.json`: alias, who invited, when, originating message ID. It does **two** things only:

1. Surfaces in newly-joining matching sessions: "📬 A pending invitation exists for @codex-helper. To take it: `walkie rename codex-helper`."
2. Lets a matching rename retroactively update `mentions-pending=codex-helper` → `mentions=codex-helper` on referencing messages.

**Skills posting via MCP** cannot prompt interactively, so they post as-is with raw text and return a structured `unresolved-mention` warning. The SKILL.md instructs the agent to surface the warning to the operator.

**Operator-in-the-loop fulfillment, not auto-claim.** No session automatically claims a pending invitation; the operator runs the rename. This avoids alias-squat attacks.

**Expiry:** invitations expire after 24h (configurable) if unfulfilled. Message text remains; `mentions-pending=` is cleared. No retroactive linking after expiry.

## 12. Edit and archive

- `walkie edit <id> "<new body>"` — body rewrite, increments `revision`, appends prior body to history file, emits `message.edited` event. Authors only (or operator override).
- `walkie archive <id> [--reason "..."]` — marks `archived=true`, banner-renders in the file, excluded from default reads. Emits `message.archived` event.
- **No hard delete.** Accountability is a design constraint.

## 13. Daemon — HTTP API

Bound to `localhost` on an auto-allocated port (default attempt: 7842, falls back to OS-assigned). Port stored in `.walkie-talkie/server.port`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/channel/latest?limit=N&include_archived=false` | Recent N messages |
| GET | `/channel/since/:ulid` | Messages strictly after given ULID |
| GET | `/channel/message/:id` | Single message + history |
| POST | `/channel/message` | Post a new message |
| PATCH | `/channel/message/:id` | Edit |
| POST | `/channel/message/:id/archive` | Archive |
| GET | `/sessions` | Active + recent sessions, pending invitations |
| POST | `/sessions/:id/rename` | Rename a session |
| POST | `/sessions/join` | Auto-join. Body: `{ tool: "claude-code"\|"claude-cowork"\|..., session_id?: string, alias?: string }`. If `session_id` is omitted, the daemon generates one. If `alias` is omitted, the daemon generates one (`<tool>-N`). |
| GET | `/permits` | List active permits |
| POST | `/permits` / `DELETE /permits/:id` | Grant / remove |
| GET | `/events` | **SSE stream** of channel events |
| GET | `/health` | Liveness |

## 14. Daemon — SSE event types

Emitted on `GET /events`:

- `message.posted` — `{ id, type, from, mentions }`
- `message.edited` — `{ id, revision }`
- `message.archived` — `{ id, by }`
- `mention.fulfilled` — `{ pending_alias, fulfilling_session_id }`
- `session.joined` / `.renamed` — `{ session_id, alias, tool }`
- `permit.granted` / `.revoked` / `.required`
- `channel.external_edit` — `{ mtime, diff_stat }` — operator hand-edited the file

Subscribers in v1: `walkie tail` (CLI), the desktop-notifier sidecar inside the daemon, and forward-compatibly any external tool.

## 15. Daemon lifecycle

`walkie start` spawns a detached Node process bound to the cwd. Writes `.walkie-talkie/server.pid` and `.walkie-talkie/server.port`. Returns immediately.

Skills auto-start the daemon on first call if the PID file is stale or missing.

`walkie stop` kills the PID. `walkie status` reports liveness.

Each project gets its own daemon on its own port. No global daemon.

## 16. MCP server

Loaded by Claude Code and Cowork via `--mcp-config` declared in `plugin.json`. Tool and resource names are deliberately chosen for LLM discoverability.

### 16.1 Tools

- `walkie_inbox` — new messages since this session's last read marker
- `walkie_read` — latest N messages (any session, any time)
- `walkie_talk` — post a message; params: `body`, `type` (default `broadcast`), `reply_to?`, `mentions?` (auto-parsed from body if not supplied); returns `{ id, warnings: [...] }`
- `walkie_reply` — convenience wrapper that pre-fills `reply_to` and the originator's @mention
- `walkie_edit` — edit a message (calling session must be author, or operator override)
- `walkie_archive` — archive a message
- `walkie_sessions` — list active sessions (so the model knows valid mention targets)
- `walkie_rename` — change this session's alias

### 16.2 Resources

- `walkie://channel/inbox` — subscribable; emits `notifications/resources/updated` on new messages where the MCP host supports it
- `walkie://channel/recent` — read-only snapshot of the last 20 messages
- `walkie://sessions/active` — current active sessions

## 17. Skill design (the LLM-facing surface)

### 17.1 Single skill, both environments

`skills/walkie-talkie/SKILL.md` auto-discovers in both Code and Cowork.

### 17.2 Natural-language invocation is the primary mode

The operator should never need to remember a command syntax inside an agent. They say:

- *"Tell Cowork the demo flow now supports refunds, ask if the slide should mention it"* → agent calls `walkie_talk` with mention + `type: "question"`.
- *"What did Cowork say last?"* → `walkie_inbox` or `walkie_read --limit 3`.
- *"Reply yes to that question — keep it scoped to the original happy path"* → `walkie_reply` with resolved `reply_to`.
- *"Take the alias 'demo-builder'"* → `walkie_rename`.

### 17.3 SKILL.md authoring approach

Scenario-driven, not command-driven. Sections:

- *When the operator asks you to send a message* — when to use `walkie_talk` vs `walkie_reply`, when to add a mention, what `type` to pick.
- *At the start of every session and before responding to user messages* — call `walkie_inbox`. Surface anything new.
- *When you receive a question from a collaborator* — read carefully, answer if confident, surface to operator otherwise.
- *When you finish a meaningful step* — broadcast a `type: "broadcast"` status update.
- *When walkie returns an `unresolved-mention` warning* — surface to the operator next turn.
- *When you save a memory entry* — post `type: "memory-update"`.

Each scenario provides 1–2 example operator phrasings. LLMs generalize from examples; this is the proven SKILL.md format.

### 17.4 Hooks (forward-compatible)

`hooks/hooks.json` ships both events. Fires today in Claude Code; inert in Cowork until [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398) ships.

- `SessionStart` (command hook) → runs `walkie inbox --since-last --format=context` → output injected into agent context.
- `UserPromptSubmit` (command hook) → same, runs on every user turn.

### 17.5 Slash commands (explicit backups)

- `/walkie-inbox` — read inbox
- `/walkie-talk "..."` — post explicitly

For operators who want determinism; not the primary path.

## 18. Notification model (latency expectations)

Honest framing: notification has two layers.

| Listener | Latency |
|---|---|
| `walkie tail` / SSE subscribers | < 100ms |
| Operator desktop notification (via `node-notifier`) | < 500ms |
| Receiving agent's next turn (Code, via hook) | Sub-second to first context injection |
| Receiving agent's next turn (Cowork, until #27398) | Bounded by next `walkie_inbox` MCP call (skill-driven) |

The agent layer is fundamentally bounded by the turn loop — no agent can be interrupted mid-thought. The three-mechanism stack maximizes practical responsiveness:

1. **Read-on-invoke** (universal baseline, Code + Cowork)
2. **Hooks** — aggressive on Code (works today), shipped on Cowork (activates the moment #27398 is fixed)
3. **MCP resource subscription** (`walkie://channel/inbox`) — passive receive where the MCP host supports it

## 19. Permission model (autonomous writes)

**Default:** sessions read autonomously at any time. Autonomous writes are **blocked** by default — each `walkie_talk` from a session is held pending until the operator confirms or the session has an active permit.

**Three modes:**

- **No permit** — every send pauses. Daemon emits `permit.required`; desktop notifier pings; agent's `walkie_talk` returns `{ status: "pending", confirm_url: "..." }`. Operator approves via `walkie permit <session> --once` or by clicking the notification.
- **Duration permit** — `walkie permit <session> --duration 30m`. Auto-expires.
- **Always-on permit** — `walkie permit <session> --always`. Cleared only by `walkie remove <session>`.

All autonomous writes carry `[autonomous]` in the marker and render with `🤖` in the signature so the operator can scan for them.

Permit state lives in `.walkie-talkie/config.json` under `permits: [...]`.

## 20. Memory-update integration

The SKILL.md instructs the agent: *"Whenever you create or update a meaningful memory entry, post a `memory-update` message summarizing what changed."*

```
**Memory updated: feedback/testing-conventions**
Saved: "this user wants integration tests to hit a real DB, not mocks."
Why: prior incident where mock/prod divergence masked a broken migration.
```

`memory-update` messages are **excluded from `walkie_inbox` by default** (informational, not actionable) but available via `walkie read --type memory-update`. This keeps the inbox focused while preserving cross-session context.

## 21. CLI surface (operator facing)

| Command | Behavior |
|---|---|
| `walkie init` | Initialize `.walkie-talkie/` in cwd |
| `walkie start` / `stop` | Daemon lifecycle |
| `walkie status [--all]` | Local channel status, or all projects |
| `walkie talk "<msg>"` | Broadcast; use `@<alias>` inline for directed attention |
| `walkie reply <id> "<msg>"` | Reply (auto-@mentions sender, sets reply-to) |
| `walkie edit <id> "<new body>"` | Edit a message you authored |
| `walkie archive <id> [--reason "..."]` | Archive |
| `walkie read [--limit N] [--since <id>] [--include-archived] [--type T]` | Read messages |
| `walkie tail` | Live SSE stream of channel events |
| `walkie sessions` | List active + recent sessions, pending invitations |
| `walkie rename <alias>` | Set this session's alias (fulfills matching invitations) |
| `walkie alias <session-id> <alias>` | Rename a specific session |
| `walkie invite <alias>` | Reserve an alias for a future session |
| `walkie permit <session-or-alias> [--duration X / --always / --once]` | Grant autonomous write |
| `walkie remove <session-or-alias>` | Remove autonomous write permission |
| `walkie config` | View/edit config |
| `walkie logs [--tail]` | View activity logs |

The CLI is explicit — no natural-language parsing. NL is the agent's job (§17.2).

## 22. Cross-platform support

macOS, Linux, Windows. Node ≥ 18.

`chokidar` handles file watching uniformly. `proper-lockfile` handles lockfiles uniformly. `node-notifier` handles desktop notifications uniformly. `child_process.spawn(..., { detached: true })` handles the daemon uniformly.

Optional Homebrew formula in the repo.

## 23. Logging

All daemon and CLI activity logs to `.walkie-talkie/logs/YYYY-MM-DD.log` with daily rotation.

Levels: `info`, `warn`, `error`, `debug`. `--verbose` flag enables debug-level output.

## 24. Testing strategy

Three layers, in priority order:

1. **`walkie-core` unit tests** — highest-risk code. Coverage:
   - ULID monotonicity
   - Concurrent appends from N processes (spawn 10 child processes, race them, assert ordered output and no torn writes)
   - Lockfile recovery after process crash
   - Header parsing edge cases
   - Hand-edit detection (internal vs external write)
   - Edit/archive marker rewriting
   - History append correctness (audit trail invariant)
2. **HTTP server integration tests** — supertest-style, against a real running daemon in a tmp directory. Every endpoint, SSE event emission, permission gating.
3. **End-to-end harness** — spawns daemon + simulates two skill-side participants (mock MCP clients) + simulates the operator CLI. Walks a representative conversation: join → talk → @mention → reply → edit → archive → invite → fulfill.

**Stretch (not v1):** an actual two-Claude-session smoke test driven by a fixture project. Useful for manual verification.

## 25. Documentation deliverables

- **README.md** — tagline, what it is, why it exists, animated GIF placeholder, install instructions (`npm install -g claude-walkie-talkie`), quick start, full usage table, FAQ
- **docs/setup.md** — installing the plugin into Code and Cowork
- **docs/api.md** — HTTP and MCP reference
- **docs/architecture.md** — mermaid diagram of message flow, with the surface map from §2
- **examples/demo-while-presenting/** — full walkthrough of the motivating workflow
- **CONTRIBUTING.md** — community contribution guide
- **LICENSE** — MIT

## 26. Out of scope for v1 (deferred)

- Multiple channels per project (one channel only; v2 may extend)
- Cross-project channels (per-project only)
- Private DMs / non-broadcast messages (broadcast + @mention only)
- LLM-driven NL CLI (`walkie ai "..."`) — agent handles NL natively
- Auto-claiming of invitations (operator-in-the-loop only)
- Hard delete (archive is the strongest removal)
- Remote / hosted relay service
- Retroactive @mention linking outside the invitation mechanism

## 27. Scope and timeline expectations

Implementation order (informs the plan phase that follows):

1. `walkie-core` — channel.js, ids.js, mentions.js, atomic-append + tests
2. Daemon — server.js, lifecycle.js, SSE, watcher + tests
3. CLI — init, talk, read, tail, sessions, rename, permit/remove
4. MCP server — tools + resources
5. SKILL.md — scenario-driven prompt
6. Hooks — SessionStart + UserPromptSubmit command hooks
7. Slash commands — `/walkie-inbox`, `/walkie-talk`
8. Documentation + examples
9. End-to-end harness

Estimated timeline for a single capable engineer working full-time: ~2 weeks for v1 (functional plugin + skills + docs). The atomic-append protocol and the daemon lifecycle are the highest-risk pieces; everything else is plumbing.

## 28. Open issues / known dependencies

- **Cowork plugin hook bug** ([anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398)) — plugin `hooks/hooks.json` doesn't fire in Cowork due to `--setting-sources user` restriction. Our hooks ship now; they activate the moment Anthropic fixes this. The README documents this honestly.
- **Cowork plugin command-hook regression for PreToolUse/PostToolUse** ([anthropics/claude-code#34573](https://github.com/anthropics/claude-code/issues/34573)) — doesn't affect us; we only use SessionStart and UserPromptSubmit.
- **MCP resource subscription support in Cowork** — unknown whether Cowork's MCP host surfaces `notifications/resources/updated` to the agent. If yes, passive receive works; if no, falls back to model-invoked `walkie_inbox`.
