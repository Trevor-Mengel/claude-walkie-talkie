```
 __      __  ______  __       __  __   ______   ____
/\ \  __/\ \/\  _  \/\ \     /\ \/\ \ /\__  _\ /\  _`\
\ \ \/\ \ \ \ \ \L\ \ \ \    \ \ \/'/'\/_/\ \/ \ \ \L\_\
 \ \ \ \ \ \ \ \  __ \ \ \  __\ \ , <    \ \ \  \ \  _\L
  \ \ \_/ \_\ \ \ \/\ \ \ \L\ \\ \ \\`\   \_\ \__\ \ \L\ \
   \ `\___x___/\ \_\ \_\ \____/ \ \_\ \_\ /\_____\\ \____/
    '\/__//__/  \/_/\/_/\/___/   \/_/\/_/ \/_____/ \/___/

 ______  ______  __       __  __   ______   ____
/\__  _\/\  _  \/\ \     /\ \/\ \ /\__  _\ /\  _`\
\/_/\ \/\ \ \L\ \ \ \    \ \ \/'/'\/_/\ \/ \ \ \L\_\
   \ \ \ \ \  __ \ \ \  __\ \ , <    \ \ \  \ \  _\L
    \ \ \ \ \ \/\ \ \ \L\ \\ \ \\`\   \_\ \__\ \ \L\ \
     \ \_\ \ \_\ \_\ \____/ \ \_\ \_\ /\_____\\ \____/
      \/_/  \/_/\/_/\/___/   \/_/\/_/ \/_____/ \/___/
```

# claude-walkie-talkie

> Give multiple Claude Code and Co-Work sessions a two-way radio to talk to each other about a multi-session project.

You're running two or three Claude sessions on the same project right now — maybe a Code session building the API alongside another writing the UI, or a Cowork session planning the release notes alongside a Code session shipping the migration. They don't know what each other are doing; every cross-session handoff is you copy-pasting context between tabs.

Walkie-talkie gives them a shared channel: a Markdown file at `.walkie-talkie/channel.md` that every session reads and writes through. Say *"tell the UI session the new endpoint is at `/v2/orders`"* in one Claude session, and it just gets there. No copy-paste, no central server, no third-party relay — the channel is a local file, and a small local daemon arbitrates concurrent writes.

## Install

> `v0.2.0` is tagged but **not yet published to npm**. The two install paths below cover today (clone + `npm link`) and post-publish (`npm install -g`). Pick whichever applies.

### Today (from a local clone)

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

### Cowork install

The `/plugin marketplace add` flow above only reaches **Claude Code**. **Claude Cowork** uses a separate install path: an MCP entry in `claude_desktop_config.json` that Claude Desktop bridges into the Cowork sandbox. See [`docs/setup.md`](docs/setup.md#install-the-plugin-into-claude-cowork) for the exact configuration. One MCP entry per walkie-enabled project (the `WALKIE_PROJECT_ROOT` env var pins the entry to a single project).

`claude.ai` web chat is not supported — cloud-only execution can't reach a local 127.0.0.1 daemon.

> **Trust note:** this plugin ships an MCP server and command hooks. Both run in your environment with your privileges. Review the source under `src/mcp-server/` and `hooks/` before installing if you don't already trust the author.

## Quick start

```sh
cd my-project
walkie init                 # operator name inferred from `git config user.name` (or OS username)
walkie start
```

Then, inside any Claude Code session at that project:

> *"Check the walkie-talkie inbox."* → the skill calls `walkie_inbox`
>
> *"Tell the UI session the new endpoint is at `/v2/orders`."* → the skill calls `walkie_talk`

The first time an agent tries to post, it'll be blocked with a permit-required response. The response includes the exact CLI to authorize:

```sh
walkie permit <session-id> --always
```

After that, the agent can post freely. The operator (you) can revoke the permit at any time with `walkie remove <session-id>`.

## Operator CLI

The full operator surface is callable directly from a terminal — no agent required. Run `walkie --help` for the live list.

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

All CLI commands are explicit — there is no natural-language parsing on the CLI; that's the agent's job. Inside a Claude session, just speak naturally: *"Ask the slide-designer session whether the deck should mention refunds."* The skill handles dispatch.

## Architecture

- **Source of truth:** `.walkie-talkie/channel.md` per project. Atomic append-at-top via `proper-lockfile`; ULID message IDs; multi-writer safe (verified with a 10-process race test).
- **Daemon:** one local Node process per project, bound to `127.0.0.1:<auto-port>`. Exposes HTTP + SSE; watches the file with `chokidar` to detect operator hand-edits.
- **Three surfaces talk to the daemon:**
  - **Operator CLI** (`walkie`) — explicit commands.
  - **MCP server** (`walkie-talkie-mcp`) — exposes the channel to Code and Cowork as tools and resources. Started by the host on demand.
  - **Skills / hooks / slash commands** — natural-language and explicit affordances inside the agent.
- **Single-writer invariant:** the daemon is the only process that writes `channel.md`. The MCP server and the CLI both proxy every mutation through daemon HTTP. This is how multi-writer correctness is preserved without a central remote service.

See [`docs/architecture.md`](docs/architecture.md) for the detailed mermaid diagrams and the message lifecycle, and [`docs/api.md`](docs/api.md) for the HTTP + MCP reference.

## Notification latency

| Listener | Latency |
|---|---|
| `walkie tail` (live SSE subscribers) | < 100ms |
| Operator desktop notification | < 500ms |
| Receiving agent's next turn — Code (via hook) | sub-second |
| Receiving agent's next turn — Cowork | bounded by next `walkie_inbox` call until [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398) ships |

The agent turn loop is the fundamental upper bound — no agent can be interrupted mid-thought. Walkie-talkie ships three reception mechanisms so practical responsiveness is as fast as the host supports.

## FAQ

**Why a file, not a server?** Each project has its own conversation; one file per project keeps it inspectable, diffable, grep-able. The daemon is local-only — there is no remote relay, no third-party state, no auth model to manage.

**Why a daemon?** Two reasons. (1) Long-lived file watching and live event fan-out need a process. (2) Centralizing writes through one process per project lets the lockfile do its job without N agents racing for it.

**Won't this clutter `channel.md`?** Yes — that's the point. The file is the conversation. Archive is the soft-delete (no hard delete, ever — accountability is a design constraint).

**What happens if two sessions pick the same alias?** Last-writer-wins on the rename, and the prior holder is suffixed with `-v2`, `-v3`, etc. Session IDs are immutable; aliases are display sugar.

**Can I edit the file by hand?** Yes — the watcher emits `channel.external_edit` so subscribers know. Hand-edits are an escape hatch, not a primary path; use `walkie talk` for normal operation.

**Is there a hosted version?** No, and there will not be. Walkie-talkie is local-only by design.

## Troubleshooting

**Plugin install fails with "invalid manifest" or stale `temp_local_…` cache entry.** A previous failed install left junk in the plugin cache. Wipe it and retry:

```sh
rm -rf ~/.claude/plugins/cache/temp_local_*
```

Then re-run `/plugin marketplace add …` + `/plugin install …`.

**The MCP tools (`walkie_*`) aren't showing up after install.** Run `/reload-plugins` in the Claude Code session. If they still don't appear, the MCP server probably crashed at startup — daemon logs are at `.walkie-talkie/logs/YYYY-MM-DD.log` and the MCP server writes errors to stderr (visible in the host's logs).

**First `walkie_talk` from an agent returns `permit_required`.** Expected — agent posts are autonomous-write and gated. The response includes the exact CLI to authorize: `walkie permit <session-id> --always` (or `--once`, `--duration 30m`). Get the `<session-id>` from `walkie sessions`.

**`walkie status --all` shows dead daemons from prior runs.** Should self-heal — the machine registry GC-prunes dead PIDs on every read. If it doesn't, `rm ~/.walkie-talkie/registry.json` wipes the machine-wide registry; per-project state under each project's `.walkie-talkie/` is unaffected.

**Cowork agent isn't seeing your messages between turns.** Cowork's plugin host doesn't fire hooks today ([anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398)). The skill instructs the agent to call `walkie_inbox` on every operator turn, which restores message flow — just bounded by turn latency, not sub-second.

## Development

```sh
git clone https://github.com/Trevor-Mengel/claude-walkie-talkie.git
cd claude-walkie-talkie
npm install
npm link              # makes the `walkie` command available globally for local dev
npm test
npm run lint
```

Run `npm unlink -g claude-walkie-talkie` to remove the global symlink.

## License

MIT
