# Changelog

All notable changes to claude-walkie-talkie will be documented here. Versioning follows [Semantic Versioning](https://semver.org/). Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] – 2026-05-16

Initial public release.

### Added

- **Operator CLI** (`walkie`) — 19 subcommands covering channel init, daemon lifecycle, messaging (talk/reply/edit/archive), session management (sessions/rename/alias/invite), permits (permit/remove), config, logs, and machine-wide status.
- **Per-project local daemon** — Express HTTP server bound to `127.0.0.1:<auto-port>` with SSE event stream, chokidar file watcher, desktop notifications, atomic-append-at-top channel writes via `proper-lockfile`, and a machine-wide registry of running projects with dead-PID garbage collection.
- **MCP server** (`walkie-talkie-mcp`) — 8 tools (`walkie_inbox`, `walkie_read`, `walkie_talk`, `walkie_reply`, `walkie_edit`, `walkie_archive`, `walkie_sessions`, `walkie_rename`) and 3 resources (`walkie://channel/inbox` with SSE subscription, `walkie://channel/recent`, `walkie://sessions/active`).
- **Claude Code plugin** with scenario-driven `SKILL.md`, SessionStart + UserPromptSubmit hooks (forward-compatible with Cowork issue [#27398](https://github.com/anthropics/claude-code/issues/27398)), `/walkie-inbox` and `/walkie-talk` slash commands, and a self-hosted marketplace via `.claude-plugin/marketplace.json`.
- **Claude Cowork support** via Claude Desktop's MCP bridge — installed at `claude_desktop_config.json` with a pinned `WALKIE_PROJECT_ROOT`. See `docs/setup.md` for the install path.
- **Operator name auto-inference** in `walkie init` (git config user.name → OS username) with strict validation against injection.
- **Channel format** — Markdown file at `.walkie-talkie/channel.md` with newest-first message blocks, durable marker comments preserving sessionId, alias, tool, timestamp, mentions, reply-to, revision, edited-at, archive state through edits.
- **Permission model** — autonomous agent writes blocked by default; operator authorizes per-session with `--once`, `--duration X`, or `--always`.
- **Full documentation** — `docs/architecture.md` (mermaid diagrams), `docs/setup.md` (install + Cowork), `docs/api.md` (HTTP + MCP reference + marker schema + input validation rules), `docs/faq.md`, `examples/demo-while-presenting/`, `CONTRIBUTING.md`.

### Security

A pre-publish audit (`security-sentinel`) surfaced five ship-blockers; all closed before release:

- Charset validation for `sessionId`, `fromAlias`, `fromTool` at every daemon route boundary — closes a marker-field-injection forgery where a crafted POST could appear authored by `operator`.
- Body and `archivedReason` content restrictions — closes a sibling-message smuggling attack via `\n## ` delimiters in message bodies.
- ULID format validation on `:id` route params + path-resolve confinement in `src/core/history.js` — closes a `..%2F` LFI primitive on `GET /channel/message/:id`.
- Operator-name sanitization in `walkie init` — closes a supply-chain-shaped attack where a poisoned `.git/config` could inject a forged `<!-- WALKIE:HEADER_END -->` marker into a freshly-init'd channel.
- Origin + Host header rejection middleware on the daemon — defangs DNS-rebinding-style browser attacks against the local-only daemon.

Five additional medium-severity findings deferred to the v0.2.1 hardening pass. See `SECURITY.md` for details.

### Known limitations

- **`claude.ai` web chat is not supported.** Cloud-only execution can't reach a local 127.0.0.1 daemon. By design.
- **Single project per Cowork install entry.** `WALKIE_PROJECT_ROOT` is fixed at MCP-server-spawn time; multi-project Cowork use requires multiple named entries in `claude_desktop_config.json`. v0.3.0 design question.
- **Cowork hooks don't fire** ([anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398)) — plugin's hooks are forward-compatible and activate when the upstream fix ships. Until then, the skill calls `walkie_inbox` on every operator turn.

### Verified

- 153/153 tests passing across 37 test files (unit, integration, security regression, end-to-end harness with two mock MCP clients).
- 0 lint errors.
- Claude Code install path verified end-to-end.
- Claude Cowork install path verified end-to-end (Cowork session posted to a channel; message landed with correct `from-tool=claude-cowork` attribution).

[0.2.0]: https://github.com/Trevor-Mengel/claude-walkie-talkie/releases/tag/v0.2.0
