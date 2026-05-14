# Plan B Kickoff Prompt

Copy/paste the block below into a fresh Claude Code session at the repo root.

---

```
I'm continuing work on claude-walkie-talkie. Plan A (operator-facing CLI + daemon + walkie-core library) is complete and committed. The project lives at the current working directory.

Background reading (please read in this order before doing anything else):
1. docs/superpowers/specs/2026-05-14-claude-walkie-talkie-design.md — the full design spec.
2. docs/superpowers/plans/2026-05-14-plan-a-operator-radio.md — Plan A (what is already built).
3. The current repo state — git log, src/, test/.

Plan A delivered (already shipped):
- walkie-core library: time, ULIDs, mentions, git metadata, message format/parse, channel atomic-append-at-top with proper-lockfile, edit/archive with history audit trail.
- Per-project local daemon: Express HTTP server, SSE event stream, chokidar watcher for external edits, desktop notifications, permits gate, machine-wide registry.
- Operator CLI: init, start/stop/status (--all), talk (with @mention interactive invite), read, tail, reply, edit, archive, sessions, rename, alias, invite, permit, remove, config, logs.

Plan B scope (what to build now):
1. MCP server (src/mcp-server/) exposing the channel as tools and resources per spec §16. Tools: walkie_inbox, walkie_read, walkie_talk, walkie_reply, walkie_edit, walkie_archive, walkie_sessions, walkie_rename. Resources: walkie://channel/inbox (subscribable), walkie://channel/recent, walkie://sessions/active.
2. Plugin assets:
   - skills/walkie-talkie/SKILL.md — scenario-driven prompt for natural-language invocation in both Code and Cowork (spec §17.2-17.3).
   - hooks/hooks.json + hooks/scripts/check-inbox.sh — SessionStart + UserPromptSubmit command hooks that inject new messages into agent context (spec §17.4). Document that these are forward-compatible with Cowork (issue anthropics/claude-code#27398).
   - commands/walkie-inbox.md, commands/walkie-talk.md — explicit slash commands (spec §17.5).
   - plugin.json and mcp.json at repo root (spec §4 file structure).
3. Documentation:
   - Full README with install/quickstart/usage table/FAQ (spec §25).
   - docs/architecture.md with mermaid diagram of the three surfaces.
   - docs/setup.md walking through installing the plugin into Code and Cowork.
   - docs/api.md as the HTTP + MCP reference.
   - examples/demo-while-presenting/ — the canonical walkthrough.
   - CONTRIBUTING.md.
4. Memory-update integration in SKILL.md per spec §20.
5. End-to-end harness (spec §24 layer 3): spawn the daemon, spawn two mock MCP clients, walk through join → talk → @mention → reply → edit → archive → invite → fulfill.

Known follow-ups from Plan A:
- parseMessage does not preserve fromTool or timestamp through edits — Plan B's MCP server will exercise edits from non-operator sessions, so fix this in walkie-core by extending the marker schema (add from-tool=X to the marker comment) and updating parseMarker.
- The machine-wide registry at ~/.walkie-talkie/registry.json accumulates stale entries from crashed test daemons. Add a GC pass to deregisterProject that prunes dead PIDs on every write.

Please use the superpowers:writing-plans skill to draft Plan B, save it to docs/superpowers/plans/<today>-plan-b-claude-integration.md, then execute via superpowers:subagent-driven-development. After writing the plan, present it section-by-section for my approval before starting execution.

Important constraints reinforced from Plan A:
- Plan A established that walkie-core is the only writer to channel.md. Plan B's MCP server MUST use the same walkie-core primitives (not bypass them) so concurrency invariants hold.
- Cowork plugin hooks do not currently fire (issue anthropics/claude-code#27398). Ship them anyway as forward-compatible; document the Cowork latency limitation honestly in the README.
- Natural language is the primary mode in Code and Cowork; SKILL.md is scenario-driven, not command-driven.
- One plugin, both environments.
- All MCP tools must call into walkie-core or the local daemon's HTTP API, never write channel.md directly.

When you start, first verify Plan A is functioning end-to-end by running the manual smoke from the end of Plan A's Task 34. Confirm before writing Plan B.
```

---

End of prompt.
