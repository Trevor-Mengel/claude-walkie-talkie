# Devsync operator runbook

## What this does

`devsync` transfers the designated-writer role between the Mac Studio and the
MacBook Pro. The current writer is authoritative. A handoff synchronizes its
committed project work, allowlisted capabilities/settings, and durable memory
to the other Mac. Only after verification does the destination become writer.

This is deliberately command-driven. Nothing runs on a timer.

## What remains separate

- Codex and Claude session transcripts and chat history
- authentication files, OAuth tokens, API keys, and keychains
- browser profiles and application caches
- file-history and telemetry folders
- live SQLite databases and their WAL/SHM files
- generated plugin caches (plugins are reinstalled from a sanitized inventory)
- generated dependencies such as `node_modules`
- temporary worktrees

Claude auto-memory Markdown under `~/.claude/projects/*/memory/` is included.
Cross-agent durable notes may be placed in
`~/.local/share/devsync/memory/`. Codex's private live memory database is not
copied; use the shared Markdown store for facts that must follow you.

## Daily commands

Check which Mac may write:

```sh
devsync status --remote
```

Confirm the current Mac is writer before starting substantial work:

```sh
devsync assert-writer
```

Preview a weekend handoff from Studio to MacBook:

```sh
devsync handoff macbook
```

Execute it after the preview is clean:

```sh
devsync handoff macbook --include-protected --execute
```

When returning home, preview and execute the reverse handoff:

```sh
devsync handoff studio --include-protected
devsync handoff studio --include-protected --execute
```

`development/Mindfull` is protected by default. Do not add
`--include-protected` until its active session explicitly confirms that all
work is finished and committed.

You can also tell Codex or Claude: “Make the MacBook the designated writer” or
“Make the Studio the designated writer.” The agent must run the same CLI and
honor its blocks.

## Handoff checklist

Before running:

1. Finish or stop every active writing session on the current writer.
2. Commit all intended project changes.
3. Remove or commit untracked work that belongs in the repositories.
4. Confirm both Macs are awake and reachable over Tailscale.
5. Run `devsync doctor --remote`.
6. Run the dry-run handoff and read every blocker.

During execution, devsync:

1. Confirms both machines agree on writer and generation.
2. Acquires a per-machine transaction lock.
3. Marks a handoff transaction in progress.
4. Rechecks that source and destination repositories are clean.
5. Pushes the source branch to its configured upstream.
6. Clones missing destination repositories or fast-forwards existing ones.
7. Exports only allowlisted configuration and memory to a staged payload.
8. Rejects recognized credentials and templates source-home paths.
9. Transfers the payload over Tailscale SSH with checksums.
10. Creates timestamped destination backups and applies the payload atomically.
11. Reinstalls missing Claude and Codex plugins, verifies their versions, and
    recreates non-secret user-level Claude MCP definitions.
12. Uses the writer's Brewfile (or generates one with Homebrew Bundle), installs
    missing packages, and verifies the bundle without removing destination
    extras.
13. Verifies repository heads and artifact hashes.
14. Demotes the old writer, promotes the new writer, and increments generation.

No reset, rebase, force push, Git clean, or destination deletion is used.

## Expected blockers

The handoff stops without changing writer state when it finds:

- uncommitted or untracked repository work
- a detached source HEAD or missing upstream
- a source branch behind its upstream
- a dirty destination checkout
- different checked-out branches for the same repository
- destination Git history that cannot fast-forward
- mismatched writer/generation records
- secret-shaped material in an allowlisted configuration file
- destination configuration drift after the prior handoff
- unreachable SSH/Tailscale connectivity

Resolve the named condition and rerun the dry run. Do not bypass a blocker by
resetting or deleting work.

Secret-bearing memory notes are skipped and named in the handoff output rather
than transferred. Authentication and OAuth still remain device-local, so a
connector may require a one-time sign-in on each Mac even when its plugin and
settings are present.

## First handoff

The first authoritative handoff backs up different destination configuration
and accepts the current writer's allowlisted copy. This is the only
source-wins bootstrap behavior. Subsequent handoffs compare canonical hashes
and block follower drift.

The initial Studio-to-MacBook handoff must wait until the active Studio
Mindfull session explicitly confirms that all work is complete and committed.

## Recovery

Start with:

```sh
devsync status --remote
```

- If both machines show the same writer and generation, the transaction is
  settled. If an interruption left locks or staging behind, run the same target
  with `--recover`.
- If both are `handoff-in-progress`, preserve both machines and rerun the same
  handoff target with `--recover` after checking that no prior handoff process
  is still running.
- If one node is committed and the other is still `handoff-in-progress`, use
  the same `--recover` command; devsync completes the second state record.
- If the nodes disagree, do not work on either checkout. Keep both online and
  ask an agent to inspect the state records and transaction backups.
- If the destination-state write fails after source demotion, devsync attempts
  to restore the original writer automatically. Verify with `status --remote`.

Backups live under:

```text
~/.local/share/devsync/backups/<transaction-id>/
```

Do not restore an entire backup tree blindly. Compare and restore only the
specific allowlisted file after identifying why the handoff failed.

## Updating the Agent Skill

The canonical skill lives in the `devsync` repository. Distribute an updated
copy to managed repositories with:

```sh
devsync install-skills
```

Mindfull is excluded automatically while protected. After its active session
is complete and committed, include it explicitly:

```sh
devsync install-skills --include-protected
```

Commit only the two generated skill directories in each repository:

```text
.agents/skills/devsync/
.claude/skills/devsync/
```

Managed copies carry a source digest. Devsync refuses to replace an unmanaged
or locally modified skill directory. The Mindfull copy stays pending until its
active Studio session is complete.
