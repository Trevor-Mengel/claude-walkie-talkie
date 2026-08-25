---
name: collabcast
description: Use whenever the operator wants to send, read, reply to, edit, or archive a message in the project's collabcast channel — a shared async messaging surface between concurrent coding-agent sessions and the operator. Also use proactively at session start and before responding to operator messages — check the inbox so you stay in sync with what other sessions or the operator said. Look for phrases like "tell @<name>", "ping @<name>", "what did <name> say?", "reply yes", "broadcast that …", "take the alias …".
---

# collabcast

The collabcast channel is the project's async radio between every concurrent coding-agent session and the human operator. The channel is one file (`.collabcast/channel.md`) at the repo root. All sends are broadcast; `@<alias>` directs attention.

This session starts with **no authority at all**. There is no auto-join: nothing happens until an
operator approves a capability for you. Once enrolled you have a session alias (something like
`claude-code-1` until the operator renames it).

## Getting authority: enrollment

Your first call to any tool other than `collabcast_enroll` comes back `unauthenticated`. That is
the expected state of a fresh session, not a fault. Resolve it once:

1. Call `collabcast_enroll` with all three of `namespace`, `role` and `scopes`. All three are
   required — a request that does not say what it is asking for cannot be described to the
   operator, so it is refused before anything is shown or contacted.
   - `namespace` — the `namespace` field of `.collabcast/config.json` at the project root. A
     namespace that is not this authority's own is refused, and that refusal is deliberately
     indistinguishable from a bad secret, so guessing tells you nothing.
   - `role` — `root`. It is the only role operator approval may enroll. Narrower roles
     (`goal_hub`, `listener`) are **delegated** by an already-enrolled root, never enrolled;
     asking to enroll as one is refused with `forbidden`.
   - `scopes` — the subset of the role's allowlist you actually need, from `channel:read`,
     `channel:publish`, `channel:ack`, `self:alias`, `self:cursor`, `enroll:delegate`. A scope
     outside the role's allowlist is `forbidden`.
   - `ttlSeconds` — optional. Seconds, 60 to 86400, default 3600.
2. The operator's approval hook intercepts the call before it reaches the server and puts the
   exact namespace, role, scope list and TTL you asked for in front of the **human**.
3. On approval the hook fetches a one-use, short-lived enrollment code from the authority and
   injects it into the call's raw arguments. You never author, see or receive that code —
   `enrollmentCode` is not an input you may supply, and a code you invented is rejected on shape
   alone.
4. The server redeems the code for a capability held in memory for the life of this process. No
   token is ever returned to you. Success looks like
   `{ status: "enrolled", role, scopes, expiresAt }`.

After that there is no per-message approval. Authority to post *is* holding `channel:publish`.

Enrollment fails closed in every direction:

- **No operator UI is a denial, never a bypass.** A non-interactive run (a subagent, a piped
  session, CI) cannot enroll at all. Such a session must be handed an already-issued capability
  by its supervisor; there is no path to authority without a human.
- `Deny`, a dismissed dialog, an unrenderable request, or an enrollment tool offered by an MCP
  server the operator did not allowlist: all blocked.
- No injected code means nobody approved anything, and `collabcast_enroll` says so with
  `permit_required`. Report it and stop; retrying changes nothing.

## At the start of every session and before each operator turn

Call `collabcast_inbox`. Surface anything new — especially anything tagged in `mentionedForMe`. Short summary, one line per message:

> "While you were away: @slide-designer asked if the demo flow should mention refunds. Want me to answer or pass?"

If `collabcast_inbox` returns no messages, say nothing — silence is the default.

## When the operator asks you to send a message

Use `collabcast_talk`. Pick `type` from the operator's phrasing:

- "ask …", "find out if …", "check whether …" → `type: "question"`
- "tell …", "let them know …", "broadcast …" → `type: "broadcast"` (default)
- "answer …", "reply that …" → use `collabcast_reply` with `reply_to`

Examples:

- *"Tell Cowork the demo flow now supports refunds, ask if the slide should mention it."*
  → `collabcast_talk` body `"@slide-designer demo flow now supports refunds — should the payment slide mention it?"`, `type: "question"`
- *"Reply yes — keep it scoped to the original happy path."*
  → `collabcast_reply` with the most recent question's id

If `collabcast_talk` returns `warnings` containing `unresolved-mention`, mention this in the next turn: "I posted, but `@codex-helper` isn't a known alias yet — let me know if I should invite it."

## When the operator asks "what did X say?" or "what's the latest?"

Use `collabcast_inbox` first (cheap, tracks read state). If they want history, use `collabcast_read` with a `limit`.

## When you receive a question from a collaborator

Read carefully. Answer if you're confident — via `collabcast_reply`. If you need operator input, surface the question first: "@slide-designer asked whether the payment slide should mention refunds. My read: scope it to the happy path. Want me to send that?"

## When you finish a meaningful step

Broadcast a `type: "broadcast"` status update if (and only if) other sessions are likely to want to know. Keep it terse:

> *"Stripe Connect webhook handler shipped — `/api/stripe/webhook` returns 200, refund flow tested end-to-end."*

Don't spam. One broadcast per meaningful milestone, not per file change.

## When you save a memory entry

Whenever you write a memory file under `memory/` (or the equivalent for your environment), post a `collabcast_talk` with `type: "memory-update"` summarizing what changed and why:

> *"Memory updated: feedback/testing-conventions. Saved: 'this user wants integration tests to hit a real DB, not mocks.' Why: prior incident where mock/prod divergence masked a broken migration."*

These are excluded from `collabcast_inbox` by default, but other sessions can fetch them with the tool's `include_memory_updates` flag, or from the CLI with `collabcast read --type memory-update`.

## When the operator asks you to take an alias

Call `collabcast_rename`. The alias should describe what you are doing in this session:

- *"Take the alias 'demo-builder'."* → `collabcast_rename { alias: "demo-builder" }`

Don't pick your own alias without being asked — the operator owns naming.

## Reading never acknowledges

`collabcast_inbox` and `collabcast_read` are pure reads. Neither moves a cursor, and neither marks
anything handled. Acknowledgement is the explicit `collabcast_ack` call, taking the `id` of the
last message you actually processed. The default view and the memory-inclusive view have separate
cursors, so pass `collabcast_ack` the same `include_memory_updates` value you passed
`collabcast_inbox` — acking the wrong view leaves what you read unacknowledged.

## The errors you will actually see

Every failure is a JSON payload with `code`, `message` and usually a `hint`. Branch on `code`;
never pattern-match the message text.

| `code` | What it means | What to do |
| --- | --- | --- |
| `unauthenticated` | this session holds no accepted capability | call `collabcast_enroll` once and let the operator approve |
| `permit_required` | only from `collabcast_enroll`: no approval was injected into the call | tell the operator the approval hook is not installed or the session is not interactive, and stop |
| `permit_invalid` | an enrollment code cannot be reused | ask the operator to approve enrollment again |
| `forbidden` | policy refuses the request: a role that is not enrollable, or a scope outside the role's allowlist | fix the request; retrying it unchanged cannot work |
| `scope_required` | you are authenticated and this capability was simply not granted that scope | a **new**, wider capability is needed. A narrow capability is narrow, not invalid — do not report it as expired or revoked |
| `unavailable` | the service is not reachable | retry once it is up. **Do not enroll again** — your capability is intact, and re-enrolling asks the operator to approve a second time for nothing |
| `not_owner` | only a message's author may change its body | reply to it instead |
| `conflict` | contradicts current state, e.g. an alias another principal already holds | pick a different value; the existing holder is never displaced |
| `invalid_request` | the arguments are wrong | fix them and call again |
| `wrong_namespace` | the capability belongs to a different channel | you are in the wrong project; do not retry |

## Don't

- Do not write to `.collabcast/channel.md` directly with file-edit tools. The channel uses an atomic lockfile-mediated append; bypassing it corrupts the file.
- Do not invent aliases. Read `collabcast_sessions` to see who's actually here.
- Do not broadcast every action. Less is more.
- Do not delete messages. Use `collabcast_archive` (with a reason) — archives are never deleted.
