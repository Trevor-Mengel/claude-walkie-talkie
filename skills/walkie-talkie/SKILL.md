---
name: walkie-talkie
description: Use whenever the operator wants to send, read, reply to, edit, or archive a message in the project's walkie-talkie channel — a shared async messaging surface between Claude Code, Claude Cowork, and the operator. Also use proactively at session start and before responding to operator messages — check the inbox so you stay in sync with what other sessions or the operator said. Look for phrases like "tell @<name>", "ping @<name>", "what did <name> say?", "reply yes", "broadcast that …", "take the alias …".
---

# walkie-talkie

The walkie-talkie channel is the project's async radio between every Claude Code session, every Claude Cowork session, and the human operator. The channel is one file (`.walkie-talkie/channel.md`) at the repo root. All sends are broadcast; `@<alias>` directs attention.

You join automatically the first time you call any walkie tool. You have a session alias (something like `claude-code-1` until the operator renames it).

## At the start of every session and before each operator turn

Call `walkie_inbox`. Surface anything new — especially anything tagged in `mentionedForMe`. Short summary, one line per message:

> "While you were away: @slide-designer asked if the demo flow should mention refunds. Want me to answer or pass?"

If `walkie_inbox` returns no messages, say nothing — silence is the default.

## When the operator asks you to send a message

Use `walkie_talk`. Pick `type` from the operator's phrasing:

- "ask …", "find out if …", "check whether …" → `type: "question"`
- "tell …", "let them know …", "broadcast …" → `type: "broadcast"` (default)
- "answer …", "reply that …" → use `walkie_reply` with `reply_to`

Examples:

- *"Tell Cowork the demo flow now supports refunds, ask if the slide should mention it."*
  → `walkie_talk` body `"@slide-designer demo flow now supports refunds — should the payment slide mention it?"`, `type: "question"`
- *"Reply yes — keep it scoped to the original happy path."*
  → `walkie_reply` with the most recent question's id

If `walkie_talk` returns `{ status: "permit_required", hint }`, surface the hint verbatim to the operator. Do not retry without operator action.

If `walkie_talk` returns `warnings` containing `unresolved-mention`, mention this in the next turn: "I posted, but `@codex-helper` isn't a known alias yet — let me know if I should invite it."

## When the operator asks "what did X say?" or "what's the latest?"

Use `walkie_inbox` first (cheap, tracks read state). If they want history, use `walkie_read` with a `limit`.

## When you receive a question from a collaborator

Read carefully. Answer if you're confident — via `walkie_reply`. If you need operator input, surface the question first: "@slide-designer asked whether the payment slide should mention refunds. My read: scope it to the happy path. Want me to send that?"

## When you finish a meaningful step

Broadcast a `type: "broadcast"` status update if (and only if) other sessions are likely to want to know. Keep it terse:

> *"Stripe Connect webhook handler shipped — `/api/stripe/webhook` returns 200, refund flow tested end-to-end."*

Don't spam. One broadcast per meaningful milestone, not per file change.

## When you save a memory entry

Whenever you write a memory file under `memory/` (or the equivalent for your environment), post a `walkie_talk` with `type: "memory-update"` summarizing what changed and why:

> *"Memory updated: feedback/testing-conventions. Saved: 'this user wants integration tests to hit a real DB, not mocks.' Why: prior incident where mock/prod divergence masked a broken migration."*

These are excluded from `walkie_inbox` by default, but other sessions can fetch them via `walkie_read --type memory-update`.

## When the operator asks you to take an alias

Call `walkie_rename`. The alias should describe what you are doing in this session:

- *"Take the alias 'demo-builder'."* → `walkie_rename { alias: "demo-builder" }`

Don't pick your own alias without being asked — the operator owns naming.

## Permits

Your first attempt to post will likely be blocked: "permit required." This is intentional — autonomous writes are gated on the operator's approval. The hint in the response tells the operator how to grant it (`walkie permit <your-session-id> --once / --duration 30m / --always`). Surface this hint verbatim and wait.

## Don't

- Do not write to `.walkie-talkie/channel.md` directly with file-edit tools. The channel uses an atomic lockfile-mediated append; bypassing it corrupts the file.
- Do not invent aliases. Read `walkie_sessions` to see who's actually here.
- Do not broadcast every action. Less is more.
- Do not delete messages. Use `walkie_archive` (with a reason) — archives are never deleted.
