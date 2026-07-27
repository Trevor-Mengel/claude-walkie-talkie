---
name: devsync
description: Safely inspect or perform the explicit writer handoff between Trevor's Mac Studio and MacBook Pro. Use when the user asks which Mac is primary, wants to sync projects/configuration/memory, wants to make the MacBook or Studio the designated writer, or needs to diagnose workstation drift. Never use for continuous background synchronization.
license: Proprietary
---

# Devsync

Use the bundled `devsync` CLI as the only mutation path. Read
[`references/runbook.md`](references/runbook.md) before a handoff or recovery.

## Safety contract

1. Treat the state record as authoritative. Run `devsync status --remote`.
2. Keep transcripts, chat history, credentials, OAuth tokens, caches, file
   history, and live SQLite/WAL/SHM files local.
3. Never reset, rebase, clean, force-push, or delete a destination checkout.
4. Require the current writer and destination checkouts to be clean.
5. Push committed source branches, fetch, and fast-forward only.
6. Back up every destination configuration file before replacement.
7. Flip writer state only after repository, artifact, and hash verification.
8. If the Studio Mindfull session is still active, do not run a handoff or
   mutate that Studio checkout.

## Common operations

Inspect without changing anything:

```sh
devsync doctor --remote
devsync status --remote
devsync handoff macbook
```

The last command is a dry run unless `--execute` is supplied.

Perform an approved handoff:

```sh
devsync handoff macbook --include-protected --execute
devsync status --remote
```

Reverse direction:

```sh
devsync handoff studio --include-protected --execute
devsync status --remote
```

The protected flag is required for a complete handoff because Mindfull is
excluded by default. Never use it until the user confirms the active Mindfull
session is finished and committed.

Before making project changes, especially when the user mentions a device
switch, run:

```sh
devsync assert-writer
```

If it reports follower status, stop and ask the user to hand off explicitly.

## Failure handling

Do not improvise destructive recovery. Preserve the transaction and backups,
run `devsync status --remote`, and follow the recovery section in the runbook.
An interrupted transaction resumes only with the same target plus `--recover`.
