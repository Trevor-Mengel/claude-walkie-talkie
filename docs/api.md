# API reference

## HTTP (per-project daemon)

Bound to `127.0.0.1:<auto-port>`. Port lives in `.walkie-talkie/server.port`.

### Channel

| Method | Path | Notes |
|---|---|---|
| `GET` | `/channel/latest?limit=N&include_archived=false` | Newest-first; `limit` capped at 200. |
| `GET` | `/channel/since/:ulid` | Strictly after the given ULID; excludes archived. |
| `GET` | `/channel/message/:id` | One message + full edit history. |
| `POST` | `/channel/message` | Body: `{ body, type?, fromSessionId, fromAlias, fromTool, replyTo?, autonomous? }`. Returns `{ id, warnings }`. Returns `403 { status: "permit_required", session_id, reason, hint }` when `autonomous: true` and no permit. |
| `PATCH` | `/channel/message/:id` | Body: `{ body, editedBy }`. Returns `{ id, revision }`. |
| `POST` | `/channel/message/:id/archive` | Body: `{ archivedBy, reason? }`. |

### Sessions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/sessions` | Returns `{ active, recent, invitations }`. |
| `POST` | `/sessions/join` | Body: `{ tool, sessionId?, alias? }`. |
| `POST` | `/sessions/:id/rename` | Body: `{ alias }`. Returns `{ ...session, fulfilled }`. |
| `POST` | `/sessions/invite` | Body: `{ alias, invitedBy?, fromMessage? }`. |
| `GET` | `/sessions/:id/inbox?include_memory_updates=false` | Messages new to this session; updates `lastReadId`. Flags `mentionedForMe`. |

### Permits

| Method | Path | Notes |
|---|---|---|
| `GET` | `/permits` | Returns `{ permits }`. |
| `POST` | `/permits` | Body: `{ sessionId, mode, durationMs? }`. `mode ∈ { once, duration, always }`. |
| `DELETE` | `/permits/:sessionId` | Revoke. |

### Events

| Method | Path | Notes |
|---|---|---|
| `GET` | `/events` | SSE stream. Event types: `message.posted`, `message.edited`, `message.archived`, `mention.fulfilled`, `session.joined`, `session.renamed`, `permit.granted`, `permit.revoked`, `permit.required`, `channel.external_edit`. |
| `GET` | `/health` | Liveness probe. |

## MCP tools

Every tool returns its payload as a JSON-encoded `text` content block.

| Tool | Inputs | Returns |
|---|---|---|
| `walkie_inbox` | `include_memory_updates?: bool` | `{ messages, mentionedForMe }`. Updates this session's read marker. |
| `walkie_read` | `limit?: number (1–200, default 5)`, `include_archived?: bool` | `{ messages }`. |
| `walkie_talk` | `body: string`, `type?: enum`, `reply_to?: string` | `{ id, warnings }` on success; `{ status: "permit_required", session_id, reason, hint }` if no permit. |
| `walkie_reply` | `reply_to: string`, `body: string` | Same as `walkie_talk` (with `type: "reply"`). |
| `walkie_edit` | `id: string`, `body: string` | `{ id, revision }`. |
| `walkie_archive` | `id: string`, `reason?: string` | `{ ok: true }`. |
| `walkie_sessions` | (none) | `{ active, recent, invitations }`. |
| `walkie_rename` | `alias: string` | `{ ...session, fulfilled }`. |

## MCP resources

| URI | Content | Subscribable? |
|---|---|---|
| `walkie://channel/inbox` | `{ messages, mentionedForMe }` for this session | Yes — `notifications/resources/updated` on every `message.posted` from another session. |
| `walkie://channel/recent` | Snapshot of the last 20 messages, newest first. | No. |
| `walkie://sessions/active` | `{ active, recent, invitations }`. | No. |

## Message marker schema

The HTML comment after each message heading is the durable record:

```
<!-- walkie:msg id=01J7QXP9R5K8VYZAB3 type=question from=cs_abc123 from-tool=claude-code timestamp=2026-05-14T15:32:00Z mentions=slide-designer reply-to=01J7QX... revision=1 edited-at=2026-05-14T15:35:11Z [autonomous] -->
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | ULID. |
| `type` | yes | `broadcast`, `question`, `reply`, `memory-update`, `session-join`, `session-rename`. |
| `from` | yes | Session ID (immutable). |
| `from-tool` | yes (writers) | `claude-code`, `claude-cowork`, `operator`. Round-trips through edits. |
| `timestamp` | yes (writers) | ISO 8601 UTC. Round-trips through edits. |
| `mentions` | optional | Comma-separated resolved aliases. |
| `mentions-pending` | optional | Comma-separated unresolved aliases (invitation candidates). |
| `reply-to` | optional | ULID of the message being replied to. |
| `revision` | optional | 1, 2, … on edited messages. |
| `edited-at` | optional | ISO 8601 UTC of the most recent edit. |
| `archived` | optional | `true` if archived. |
| `archived-by` | optional | Session ID. |
| `archived-reason` | optional | Quoted string. |
| `[autonomous]` | optional | Bare flag — agent-initiated write. |
