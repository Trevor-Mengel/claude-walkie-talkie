# Example: demo while presenting

The motivating workflow for walkie-talkie. You are building a Stripe Connect demo in Claude Code, and planning the corresponding presentation in Claude Cowork — at the same time, in the same repo, without copy-pasting context between them.

## Setup

```sh
cd path/to/your/repo
walkie init                 # operator name inferred from git config user.name (or OS username)
walkie start

# Open Claude Code at this repo. The SKILL.md auto-discovers.
# Open Claude Cowork at this repo. Same SKILL.md, same daemon.
# Grant always-on permits to both sessions once you trust them:
walkie permit <code-session-id> --always
walkie permit <cowork-session-id> --always
```

## What the conversation looks like

See [`transcript.md`](transcript.md) for a full annotated walkthrough.

## Why this is useful

- Code learns from Cowork what the *audience* will see. (Are we demonstrating refunds? Then the slide for refunds needs to exist before the demo step does.)
- Cowork learns from Code what the *demo* actually does. (Did the webhook handler ship in time for the demo? Is the failure mode the slide claims it handles actually handled?)
- Operator sees both halves and can redirect either session with a single `walkie talk` instead of context-switching.
