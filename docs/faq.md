# FAQ

### `npm install -g collabcast` returns 404. What gives?

The package isn't on npm yet — nobody has run `npm publish`. Until then, install from a clone:

```sh
git clone https://github.com/Trevor-Mengel/collabcast.git
cd collabcast
npm install
npm link
```

`npm link` exposes the `collabcast` binary on your PATH from your local clone. See `docs/setup.md` for the matching plugin install (filesystem marketplace).

### My plugin install failed with "invalid manifest" and left a `temp_local_…` cache entry.

A prior failed install dropped an unfinished marketplace into `~/.claude/plugins/cache/`. Wipe it and retry:

```sh
rm -rf ~/.claude/plugins/cache/temp_local_*
```

Then re-run `/plugin marketplace add …` + `/plugin install …`.

### Why a file, not a server?

Each project has its own conversation. Keeping it in a file means it's inspectable, diffable, grep-able and archivable. The service is local-only — no remote relay and no third-party state.

### Why a background service per project?

Two reasons. (1) Long-lived file watching and live event fan-out need a process. (2) Centralizing writes through one process per namespace lets `proper-lockfile` do its job without N agents racing for it. The single-writer invariant is the load-bearing piece — if you bypass it, you lose multi-writer correctness.

### Why does my agent's first tool call fail with `unauthenticated`?

Because it holds no capability yet, and identity is something the authority issues rather than something a client asserts. The agent resolves it by calling `collabcast_enroll`; you get an approval dialog showing the namespace, role and scopes being requested, and approving it issues a one-use enrollment code that the client redeems for a capability held in memory for the life of that process. The agent never authors or sees the code.

There is no per-post approval after that. Authority to publish *is* holding the `channel:publish` scope.

### What happened to permits?

Removed in v0.3. `POST /permits`, `DELETE /permits/:sessionId` and the `--always` / `--once` / `--duration` CLI gate are gone; those routes now answer 404. The per-post gate asked the wrong question — it authorized an *action* on a session whose identity was itself unverified. Authority is now a capability with scopes, checked on every request.

To take authority away, revoke the capability: `collabcast revoke <capability-id>`. It cascades over everything that capability delegated.

### A tool call returned `scope_required`. What do I do?

The session authenticated fine, but its capability was never granted that scope. Scopes are fixed when a capability is issued and can only ever narrow, so this needs a *new* capability rather than an edit to the existing one. A `listener`, for example, holds `channel:read` but not `channel:publish` — it can follow the channel and never write to it.

### Does reading my inbox mark it read?

No. Every read is non-mutating — `collabcast_inbox`, `collabcast_read`, and all three `collabcast://` resources. Acknowledging is the separate `collabcast_ack` tool (`collabcast ack <id>` on the CLI).

This matters because an MCP client may read a resource on its own initiative, on refresh or reconnect or a subscription notification. When reading consumed the cursor, messages disappeared without anyone deciding they had been handled.

### Why does `collabcast_ack` need `include_memory_updates`?

Because there are two inbox views and each has its own cursor pair. `include_memory_updates: false` hides `memory-update` messages; `true` includes them. Acking with the flag you *didn't* read with leaves what you read unacknowledged.

Pass `false` and only the default mark moves — you saw no evidence about the messages that view hid from you. Pass `true` and both marks move, because the memory-inclusive view is a superset of the default one.

### Cowork hooks don't seem to fire.

[anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398). Cowork's plugin host doesn't fire hooks today. The plugin ships them anyway; they activate the moment the upstream fix lands. Until then, the SKILL.md prompts `collabcast_inbox` on every operator turn, so messages still flow — just bounded by turn latency instead of sub-second.

### Two sessions picked the same alias. What happens?

The newcomer is refused with `conflict` and the incumbent keeps its alias untouched. Nothing is renamed or suffixed.

This is deliberate. v0.2 renamed the incumbent out of the way, which meant an alias could be stolen by anyone who asked for it — and since directed messages were matched on the alias string, stealing one redirected another principal's traffic. Mentions now resolve to principal ids, which are unforgeable and survive renames.

### Can I commit `.collabcast/channel.md` to git?

No. `collabcast init` adds `.collabcast/` to your `.gitignore`, and the service **refuses to start** while `channel.md` is tracked — a committed channel is shipped to every clone, which makes it a supply-chain vector rather than a tidiness problem. If `init` warns that the file is already tracked, run `git rm -r --cached .collabcast` and commit that removal.

### Can I edit `channel.md` by hand?

Yes. The watcher emits `channel.external_edit` so subscribers know something changed. Hand-edits are an escape hatch, not a primary path — use `collabcast talk` for normal operation. Don't write to the file while the service is mid-write (vanishingly rare in practice; the lockfile is the safeguard).

### What about hard delete?

There is none. `collabcast archive` is the strongest removal. Accountability is a design constraint — agents can't unilaterally make their own messages disappear. Editing is authorship, so only the author may change a body, operator included; archiving is moderation, so the author *or* an operator may do it. If you absolutely need to remove a message (legal reasons, secrets leaked), edit the file by hand while the service is stopped.

### Is there a hosted version?

No, and there will not be. Collabcast is local-only by design.

### How do I reset everything?

```sh
collabcast stop                     # standalone mode only
rm -rf .collabcast/                 # per project: channel, store, logs, sockets
```

Then remove the project's entry from `~/.collabcast/identities.json` to drop its namespace from the host identity map.

### Where do the logs live?

`.collabcast/logs/YYYY-MM-DD.log`. Run `collabcast logs --tail 50` to inspect the recent ones. Authority decisions are additionally recorded in the append-only audit table inside `.collabcast/store/collabcast.db`.
