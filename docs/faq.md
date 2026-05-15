# FAQ

### Why a file, not a server?

Each project has its own conversation. Keeping it in a file means it's inspectable, diffable, grep-able, archivable, and tied to the project's git history (if you choose to commit it). The daemon is local-only — no remote relay, no third-party state, no auth model to manage.

### Why a daemon per project?

Two reasons. (1) Long-lived file watching and live event fan-out need a process. (2) Centralizing writes through one process per project lets `proper-lockfile` do its job without N agents racing for it. The single-writer invariant is the load-bearing piece — if you bypass it, you lose multi-writer correctness.

### Why is my first agent post blocked?

By design — agent posts are autonomous writes, and walkie defaults to operator-in-the-loop. The blocked response includes the exact `walkie permit` invocation. Run `walkie permit <session> --once` (or `--duration 30m`, or `--always`) and the agent's next attempt succeeds.

### Cowork hooks don't seem to fire.

[anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398). Cowork's plugin host doesn't fire hooks today. The plugin ships them anyway; they activate the moment the upstream fix lands. Until then, the SKILL.md prompts `walkie_inbox` on every operator turn, so messages still flow — just bounded by turn latency instead of sub-second.

### Two sessions picked the same alias. What happens?

Last-writer-wins on rename, and the prior holder is suffixed (`demo-builder` → `demo-builder-v2`). Session IDs are immutable; aliases are display sugar.

### Can I commit `.walkie-talkie/channel.md` to git?

You can — the file is plain Markdown and renders fine on GitHub. Practical caveats: it grows monotonically (archive is the only "delete"), and you'll get merge conflicts on every concurrent write across branches. Most teams gitignore it and keep it local.

### Can I edit `channel.md` by hand?

Yes. The watcher emits `channel.external_edit` so subscribers know something changed. Hand-edits are an escape hatch, not a primary path — use `walkie talk` for normal operation. Don't write to the file while the daemon is mid-write (vanishingly rare in practice; the lockfile is the safeguard).

### What about hard delete?

There is none. `walkie archive` is the strongest removal. Accountability is a design constraint — agents can't unilaterally make their own messages disappear. If you absolutely need to remove a message (legal reasons, secrets leaked), edit the file by hand while the daemon is stopped.

### Is there a hosted version?

No, and there will not be. Walkie-talkie is local-only by design.

### How do I reset everything?

```sh
walkie stop
rm -rf .walkie-talkie/             # per project
rm ~/.walkie-talkie/registry.json  # machine-wide registry
```

### Where do the logs live?

`.walkie-talkie/logs/YYYY-MM-DD.log`. Run `walkie logs --tail 50` to inspect the recent ones.
