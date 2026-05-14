# claude-walkie-talkie

> Two-way radio for Claude Code and Claude Cowork sessions working on the same project.

**Status:** Plan A complete — operator-facing CLI + local daemon. Plan B (the Claude plugin integration) is the next milestone.

## What works today

```sh
walkie init --operator "Your Name" --name "project-name"
walkie start
walkie talk "hello"
walkie talk "@some-future-helper got time?"   # interactively invites
walkie read --limit 10
walkie tail
walkie reply <id> "yes, exactly"
walkie edit <id> "fixed typo"
walkie archive <id> --reason "duplicate"
walkie sessions
walkie invite codex-helper
walkie alias <session-id> demo-builder
walkie permit <session> --once|--duration 30m|--always
walkie remove <session>
walkie status            # this project
walkie status --all      # all walkie projects on this machine
walkie stop
```

A standalone operator-driven channel. Plan B wires the same channel into Claude Code and Cowork via skills, hooks, MCP server, and slash commands.

## Architecture

- `.walkie-talkie/channel.md` is the source of truth (per project).
- Atomic append-at-top via lockfile; ULID message IDs; multi-writer safe (verified with a 10-process race test).
- Local Node daemon exposes HTTP + SSE; chokidar watches for hand-edits.
- CLI talks to the daemon over `http://127.0.0.1:<port>` (port allocated and recorded in `.walkie-talkie/server.port`).

See `docs/superpowers/specs/2026-05-14-claude-walkie-talkie-design.md` for the full design.

## Install (post-1.0)

```sh
npm install -g claude-walkie-talkie
```

## Known limitations (Plan A scope)

- No Claude integration yet (Plan B).
- The machine-wide registry at `~/.walkie-talkie/registry.json` can accumulate stale entries from crashed test daemons; `walkie status --all` may list dead PIDs until a future GC pass is added.
- `parseMessage` does not preserve `fromTool` or `timestamp` through edits — affects how edited messages from agents (not operator) are re-rendered. Plan B will surface this when agents edit their own messages.

## License

MIT
