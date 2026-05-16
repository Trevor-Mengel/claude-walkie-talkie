# claude-walkie-talkie

> Two-way radio for Claude Code and Claude Cowork sessions working on the same project.

**Status:** Plans A + B complete — operator CLI + per-project daemon + MCP server + Claude plugin. Ready for v0.2.0 release.

Asynchronous, broadcast-style messaging between every Claude Code session, every Claude Cowork session, and the human operator. One channel file per project, atomic append-at-top, no central server. Plugin works in both Code and Cowork off a single install.

## Why

When you're building a demo in Code while planning a presentation in Cowork (or running two Code sessions on different parts of the same repo), you spend most of your time copy-pasting context between them. Walkie-talkie is a shared async surface so you stop doing that — say "tell the slide deck session the refund flow ships," and it just gets there.

## Install

> **Current status:** `v0.2.0` is tagged but **not yet published to npm**. The two install paths below cover today (clone + `npm link`) and post-publish (`npm install -g`). Pick whichever applies.

### Today (from a local clone)

The npm package isn't on the registry yet, so install the CLI by cloning and linking:

```sh
git clone https://github.com/Trevor-Mengel/claude-walkie-talkie.git
cd claude-walkie-talkie
npm install
npm link              # exposes the `walkie` binary globally
```

Install the plugin in any project by registering the local clone as a filesystem marketplace from inside Claude Code:

```
/plugin marketplace add /absolute/path/to/claude-walkie-talkie
/plugin install walkie-talkie@claude-walkie-talkie
/reload-plugins
```

### Once published to npm

```sh
npm install -g claude-walkie-talkie
```

And install the plugin from the GitHub marketplace:

```
/plugin marketplace add Trevor-Mengel/claude-walkie-talkie
/plugin install walkie-talkie@claude-walkie-talkie
/reload-plugins
```

The `/plugin marketplace add` flow above installs walkie-talkie into **Claude Code**. **Claude Cowork** uses a separate install path: an MCP entry in `claude_desktop_config.json` that Claude Desktop bridges into the Cowork sandbox. See [`docs/setup.md`](docs/setup.md#install-the-plugin-into-claude-cowork) for the exact configuration — one MCP entry per walkie-enabled project. `claude.ai` web chat is not supported (cloud-only execution can't reach the local daemon).

> **Trust note:** this plugin ships an MCP server and command hooks. Both run in your environment with your privileges. Review the source under `src/mcp-server/` and `hooks/` before installing if you don't already trust the author.

## Quick start

```sh
cd my-project
walkie init                 # operator name inferred from `git config user.name` (or OS username)
walkie start
# In a Claude Code session at the same project root:
#   "Check the walkie-talkie inbox."   ← the skill will call walkie_inbox
#   "Tell Cowork the API is wired."    ← walkie_talk
# Operator grants the first permit:
walkie permit <session-id> --always
```

The operator-side CLI also works standalone — see [Operator CLI](#operator-cli) below.

## Usage table

| What you want | How |
|---|---|
| Initialize a channel | `walkie init` (override with `--operator "Name"` and/or `--name <project>`) |
| Start / stop the daemon | `walkie start` / `walkie stop` |
| Status (this project / all projects) | `walkie status` / `walkie status --all` |
| Post as the operator | `walkie talk "@alias message"` |
| Read recent messages | `walkie read --limit 10` |
| Watch live events | `walkie tail` |
| Reply / edit / archive | `walkie reply <id> "…"`, `walkie edit <id> "…"`, `walkie archive <id>` |
| List sessions / rename your session | `walkie sessions`, `walkie rename <alias>` |
| Reserve an alias for a future session | `walkie invite <alias>` |
| Grant or revoke autonomous-write permit | `walkie permit <session> --once\|--duration X\|--always` / `walkie remove <session>` |
| View / edit config | `walkie config` |
| View activity logs | `walkie logs --tail 50` |

Inside an agent: just speak naturally. "Ask Cowork whether the slide should mention refunds." "What did the demo-builder session say?" The SKILL.md handles dispatch.

## Architecture

- **Source of truth:** `.walkie-talkie/channel.md` per project. Atomic append-at-top via `proper-lockfile`; ULID message IDs; multi-writer safe (verified with a 10-process race test).
- **Daemon:** one local Node process per project, bound to `127.0.0.1:<auto-port>`. Exposes HTTP + SSE; watches the file with `chokidar` to detect operator hand-edits. PID/port recorded in `.walkie-talkie/server.pid` and `.walkie-talkie/server.port`.
- **Three surfaces talk to the daemon:**
  - **Operator CLI** (`walkie`) — explicit commands.
  - **MCP server** (`walkie-talkie-mcp`) — exposes the channel to Code and Cowork as tools and resources. Started by the host on demand.
  - **Skills / hooks / slash commands** — natural-language and explicit affordances inside the agent.
- **Single writer invariant:** the daemon is the only process that writes `channel.md`. The MCP server proxies every mutation through daemon HTTP. The CLI same.

See [`docs/architecture.md`](docs/architecture.md) for a detailed mermaid diagram.

## Operator CLI

The full surface, callable directly from a terminal (no agent required). Run `walkie --help` for the live list; the [usage table](#usage-table) above is the quick reference. All commands are explicit — there is no natural-language parsing on the CLI; that's the agent's job.

## Notification latency

| Listener | Latency |
|---|---|
| `walkie tail` (live SSE subscribers) | < 100ms |
| Operator desktop notification | < 500ms |
| Receiving agent's next turn — Code (via hook) | sub-second |
| Receiving agent's next turn — Cowork | bounded by next `walkie_inbox` call until anthropics/claude-code#27398 ships |

The agent turn loop is the fundamental upper bound — no agent can be interrupted mid-thought. Walkie-talkie ships three reception mechanisms so practical responsiveness is as fast as the host supports.

## Cowork status

Walkie-talkie's hooks are forward-compatible with Cowork: `hooks/hooks.json` is shipped today and will activate the moment Anthropic fixes [claude-code#27398](https://github.com/anthropics/claude-code/issues/27398). Until then, Cowork receives messages on its next `walkie_inbox` call (skill-driven), which the SKILL.md prompts on every operator turn.

## FAQ

**Why a file, not a server?** Each project has its own conversation; one file per project keeps it inspectable, diffable, grep-able. The daemon is local-only — there is no remote relay, no third-party state, no auth model to manage.

**Why a daemon?** Two reasons. (1) Long-lived file watching (chokidar) and live event fan-out (SSE) need a process. (2) Centralizing writes through one process per project lets the lockfile do its job without N agents racing for it.

**Won't this clutter `channel.md`?** Yes — that's the point. The file is the conversation. Archive is the soft-delete (no hard delete, ever — accountability is a design constraint).

**What happens if two sessions pick the same alias?** Last-writer-wins on the rename, and the prior holder is suffixed with `-v2`, `-v3`, etc. The session ID is the immutable identifier; aliases are display sugar.

**Can I edit the file by hand?** Yes — the watcher emits `channel.external_edit` so subscribers know. Hand-edits are an escape hatch, not a primary path; use `walkie talk` instead.

**Is there a hosted version?** No, and there will not be. Walkie-talkie is local-only by design.

## Troubleshooting

**Plugin install fails with "invalid manifest" or stale temp_local_… cache entry.** A previous failed install left junk in the plugin cache. Wipe it and retry:

```sh
rm -rf ~/.claude/plugins/cache/temp_local_*
```

Then re-run `/plugin marketplace add …` + `/plugin install …`.

**The MCP tools (`walkie_*`) aren't showing up after install.** Run `/reload-plugins` in the Claude Code session. If they still don't appear, the MCP server probably crashed at startup — daemon logs are at `.walkie-talkie/logs/YYYY-MM-DD.log` and the MCP server writes errors to stderr (visible in the host's logs).

**First `walkie_talk` from an agent returns `permit_required`.** Expected. Agent posts are autonomous-write and gated. The response includes the exact CLI to authorize:

```sh
walkie permit <session-id> --always   # or --once, --duration 30m
```

Get the `<session-id>` from `walkie sessions`.

**`walkie status --all` shows dead daemons from prior runs.** Should self-heal — the machine registry GC-prunes dead PIDs on every read. If it doesn't, `rm ~/.walkie-talkie/registry.json` wipes the machine-wide registry; per-project state under each project's `.walkie-talkie/` is unaffected.

**Cowork agent isn't seeing your messages between turns.** Cowork's plugin host doesn't fire hooks today ([anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398)). The SKILL.md instructs the agent to call `walkie_inbox` on every operator turn, which restores message flow — just bounded by turn latency, not sub-second.

## Development

```sh
git clone https://github.com/Trevor-Mengel/claude-walkie-talkie.git
cd claude-walkie-talkie
npm install
npm link              # makes the `walkie` command available globally for local dev
npm test
npm run lint
```

The local clone exposes the `walkie` binary on your PATH via `npm link`. Run `npm unlink -g claude-walkie-talkie` to remove it.

## License

MIT
