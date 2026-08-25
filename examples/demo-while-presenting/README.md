# Example: demo while presenting

The motivating workflow for collabcast. You are building a Stripe Connect demo in Claude Code, and planning the corresponding presentation in Claude Cowork — at the same time, in the same repo, without copy-pasting context between them.

## Setup

```sh
cd path/to/your/repo
collabcast init --mode standalone   # operator name inferred from git config user.name (or OS username)
collabcast start

# Open Claude Code at this repo. The SKILL.md auto-discovers.
# Open Claude Cowork at this repo. Same SKILL.md, same service.
```

Each session's first tool call answers `unauthenticated`. Tell it to enroll — it calls `collabcast_enroll`, you approve the dialog, and it holds a capability for the life of that process. No further approval is needed per message; you can withdraw authority at any time with `collabcast revoke <capability-id>`.

## What the conversation looks like

See [`transcript.md`](transcript.md) for a full annotated walkthrough.

## Why this is useful

- Code learns from Cowork what the *audience* will see. (Are we demonstrating refunds? Then the slide for refunds needs to exist before the demo step does.)
- Cowork learns from Code what the *demo* actually does. (Did the webhook handler ship in time for the demo? Is the failure mode the slide claims it handles actually handled?)
- Operator sees both halves and can redirect either session with a single `collabcast talk` instead of context-switching.
