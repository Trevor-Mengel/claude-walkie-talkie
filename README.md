```
   ******    *******   **       **           **     ******
  **////**  **/////** /**      /**          ****   /*////**
 **    //  **     //**/**      /**         **//**  /*   /**
/**       /**      /**/**      /**        **  //** /******
/**       /**      /**/**      /**       **********/*//// **
//**    **//**     ** /**      /**      /**//////**/*    /**
 //******  //*******  /********/********/**     /**/*******
  //////    ///////   //////// //////// //      // ///////

   ******      **      ******** **********
  **////**    ****    **////// /////**///
 **    //    **//**  /**           /**
/**         **  //** /*********    /**
/**        **********////////**    /**
//**    **/**//////**       /**    /**
 //****** /**     /** ********     /**
  //////  //      // ////////      //
```

# collabcast

> Give multiple coding-agent sessions a two-way radio to talk to each other about a multi-session project.

You're running two or three agent sessions on the same project right now — maybe one building the API alongside another writing the UI, or one planning the release notes alongside another shipping the migration. They don't know what each other are doing; every cross-session handoff is you copy-pasting context between tabs.

Collabcast gives them a shared channel: a Markdown file at `.collabcast/channel.md` that every session reads and writes through. Say *"tell the UI session the new endpoint is at `/v2/orders`"* in one session, and it just gets there. No copy-paste, no central server, no third-party relay — the channel is a local file, and a small local service arbitrates concurrent writes over a Unix socket.

## Install

The CLI:

```sh
npm install -g collabcast
```

The plugin (run inside Claude Code):

```
/plugin marketplace add Trevor-Mengel/collabcast
/plugin install collabcast@collabcast
/reload-plugins
```

### Local-clone install (for development or for testing unreleased changes)

```sh
git clone https://github.com/Trevor-Mengel/collabcast.git
cd collabcast
npm install
npm link              # exposes the `collabcast` binary globally from this clone
```

Then register the clone as a filesystem marketplace from inside Claude Code:

```
/plugin marketplace add /absolute/path/to/collabcast
/plugin install collabcast@collabcast
/reload-plugins
```

### Cowork install

The `/plugin marketplace add` flow above only reaches **Claude Code**. **Claude Cowork** uses a separate install path: an MCP entry in `claude_desktop_config.json` that Claude Desktop bridges into the Cowork sandbox. See [`docs/setup.md`](docs/setup.md#install-the-plugin-into-claude-cowork) for the exact configuration. One MCP entry per collabcast-enabled project (the `COLLABCAST_PROJECT_ROOT` env var pins the entry to a single project).

`claude.ai` web chat is not supported — cloud-only execution can't reach a local Unix socket.

Those two are the install paths documented here because they are the ones verified end to end. Nothing in the product is Claude-specific: the MCP server speaks stdio JSON-RPC, so any MCP-capable host can load `collabcast-mcp` directly and get the same tools and resources.

> **Trust note:** this plugin ships an MCP server and command hooks. Both run in your environment with your privileges. Review the source under `src/mcp-server/`, `hooks/` and `omp-extension/` before installing if you don't already trust the author.

## Quick start

```sh
cd my-project
collabcast init                 # operator name inferred from `git config user.name` (or OS username)
```

`init` writes `.collabcast/`, registers the project's namespace in `~/.collabcast/identities.json`, and adds `.collabcast/` to `.gitignore`. The default mode is `managed`, meaning a supervisor (Paseo) owns the service lifecycle. In `standalone` mode you start it yourself:

```sh
collabcast init --mode standalone
collabcast start
```

Then, inside any agent session at that project:

> *"Check the collabcast inbox."* → the skill calls `collabcast_inbox`
>
> *"Tell the UI session the new endpoint is at `/v2/orders`."* → the skill calls `collabcast_talk`

The first time a session tries to do anything it has no capability, so it gets `unauthenticated` back. It resolves that by calling `collabcast_enroll`, which triggers an operator approval dialog; approving it mints a capability held in memory for the life of that process. The agent never sees or authors the enrollment code. There is no per-post permission prompt after that — authority to publish *is* the `channel:publish` scope on the capability.

To revoke a session's authority at any time:

```sh
collabcast whoami                  # or `collabcast sessions` for the whole roster
collabcast revoke <capability-id>  # cascades over everything it delegated
```

## Operator CLI

The full operator surface is callable directly from a terminal — no agent required. Run `collabcast --help` for the live list.

> **Prerequisite:** every CLI command except `init` / `start` / `stop` / `status` authenticates with the operator credential at `.collabcast/run/operator.cred` (mode `0600`). The service mints it at startup, so `collabcast init && collabcast start` is all a fresh install needs. It is a real, revocable capability: `collabcast revoke <capability-id>` on your own capability locks the CLI out until you delete `operator.cred` and restart the service, which mints a fresh one.

| What you want | How |
|---|---|
| Initialize a channel | `collabcast init` (override with `--operator "Name"`, `--name <project>`, `--namespace <ns>`, `--mode <managed\|standalone>`) |
| See your own identity and scopes | `collabcast whoami` (add `--json`) |
| Start / stop the service (standalone only) | `collabcast start` / `collabcast stop` |
| Status (this project / every namespace) | `collabcast status` / `collabcast status --all` |
| Post as the operator | `collabcast talk "@alias message"` |
| Read recent messages | `collabcast read --limit 10` |
| See your unread messages (never acknowledges) | `collabcast inbox` |
| Acknowledge through a message | `collabcast ack <id>` (add `--no-mark-read` to ack without moving the read cursor) |
| Watch live events | `collabcast tail` |
| Reply / edit / archive | `collabcast reply <id> "…"`, `collabcast edit <id> "…"`, `collabcast archive <id>` |
| List principals / rename yourself | `collabcast sessions`, `collabcast rename <alias>` |
| Break-glass capability mint | `collabcast enroll --recovery --role listener --scopes channel:read,self:cursor` |
| Revoke a capability and its delegations | `collabcast revoke <capability-id>` |
| View / edit config | `collabcast config` |
| View activity logs | `collabcast logs --tail 50` |

All CLI commands are explicit — there is no natural-language parsing on the CLI; that's the agent's job. Inside an agent session, just speak naturally: *"Ask the slide-designer session whether the deck should mention refunds."* The skill handles dispatch.

## Architecture

- **Source of truth:** `.collabcast/channel.md` per project. Atomic append-at-top via `proper-lockfile`; ULID message IDs; multi-writer safe (verified with a multi-process race test).
- **Service:** one local Node process per namespace, listening on an owner-only Unix socket at `.collabcast/run/collabcast.sock`. Exposes HTTP + SSE over that socket; watches the file with `chokidar` to detect operator hand-edits. Loopback TCP exists but is off by default.
- **Authority:** every request carries a capability as a bearer token. Capabilities are rows in a SQLite store under `.collabcast/store/`, minted only by an operator-approved enrollment, by delegation from a root or operator capability, or — for the operator's own break-glass credential — by the service at startup for the uid that owns the runtime directory. Every route enforces a named scope.
- **Three surfaces talk to the service:**
  - **Operator CLI** (`collabcast`) — explicit commands, authenticating with the operator credential at `.collabcast/run/operator.cred`.
  - **MCP server** (`collabcast-mcp`) — exposes the channel to agent hosts as tools and resources. Started by the host on demand.
  - **Skills / hooks / slash commands** — natural-language and explicit affordances inside the agent.
- **Single-writer invariant:** the service is the only process that writes `channel.md`. The MCP server and the CLI both proxy every mutation through its HTTP API. This is how multi-writer correctness is preserved without a central remote service.

See [`docs/architecture.md`](docs/architecture.md) for the detailed diagrams and the message lifecycle, and [`docs/api.md`](docs/api.md) for the HTTP + MCP reference.

## Known gaps

- **The operator credential cannot be re-issued without filesystem access.** The service refuses to mint over an `operator.cred` it will not honour — a revoked one especially — so recovery is `rm .collabcast/run/operator.cred && collabcast start`, which needs the uid that owns the runtime directory. That is the intended security property, not a convenience gap, but there is no `collabcast reissue` command.
- **SSE is best-effort.** `GET /events` replays nothing and survives no restart, so a subscriber that reconnects can miss events emitted while it was away. Durable event delivery is a planned change.
- **Renaming from `claude-walkie-talkie` has no migration path.** An existing project keeps its `.walkie-talkie/` directory, and the SessionStart hook looks only for `.collabcast/` — so in that project the plugin silently does nothing until the directory is moved. Fresh `collabcast init` runs are unaffected.

## Notification latency

| Listener | Latency |
|---|---|
| `collabcast tail` (live SSE subscribers) | < 100ms |
| Operator desktop notification | < 500ms |
| Receiving agent's next turn — Code (via hook) | sub-second |
| Receiving agent's next turn — Cowork | bounded by next `collabcast_inbox` call until [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398) ships |

The agent turn loop is the fundamental upper bound — no agent can be interrupted mid-thought. Collabcast ships three reception mechanisms so practical responsiveness is as fast as the host supports.

## FAQ

**Why a file, not a server?** Each project has its own conversation; one file per project keeps it inspectable, diffable, grep-able. The service is local-only — there is no remote relay and no third-party state.

**Why a background service?** Two reasons. (1) Long-lived file watching and live event fan-out need a process. (2) Centralizing writes through one process per namespace lets the lockfile do its job without N agents racing for it.

**Won't this clutter `channel.md`?** Yes — that's the point. The file is the conversation. Archive is the soft-delete (no hard delete, ever — accountability is a design constraint).

**What happens if two sessions pick the same alias?** The newcomer is refused with `conflict`. The principal already holding the alias is never renamed or displaced.

**Does reading my inbox mark it read?** No. Every read is non-mutating. Acknowledging is the explicit `collabcast_ack` tool (`collabcast ack <id>` on the CLI), and the two inbox views — with and without memory updates — carry separate cursors, so ack the same view you read.

**Can I edit the file by hand?** Yes — the watcher emits `channel.external_edit` so subscribers know. Hand-edits are an escape hatch, not a primary path; use `collabcast talk` for normal operation.

**Is there a hosted version?** No, and there will not be. Collabcast is local-only by design.

## Troubleshooting

**Plugin install fails with "invalid manifest" or stale `temp_local_…` cache entry.** A previous failed install left junk in the plugin cache. Wipe it and retry:

```sh
rm -rf ~/.claude/plugins/cache/temp_local_*
```

Then re-run `/plugin marketplace add …` + `/plugin install …`.

**The MCP tools (`collabcast_*`) aren't showing up after install.** Run `/reload-plugins` in the session. If they still don't appear, the MCP server probably crashed at startup — logs are at `.collabcast/logs/YYYY-MM-DD.log` and the MCP server writes errors to stderr (visible in the host's logs).

**Every tool call returns `unauthenticated`.** The session holds no capability yet. Have the agent call `collabcast_enroll` and approve the dialog. If the dialog never appears, the enrollment socket isn't reachable — check `.collabcast/run/authority.sock` exists and that `.collabcast/run/` is mode `700`.

**Tool calls return `unavailable`.** Nothing is listening on the namespace socket. In `standalone` mode run `collabcast start`. In `managed` mode the supervisor owns the lifecycle and clients deliberately refuse to start one behind its back — start it through the supervisor.

**`collabcast status --all` shows namespaces you no longer use.** The host identity map is `~/.collabcast/identities.json`; remove the stale entry there. Per-project state under each project's `.collabcast/` is independent.

**Cowork agent isn't seeing your messages between turns.** Cowork's plugin host doesn't fire hooks today ([anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398)). The skill instructs the agent to call `collabcast_inbox` on every operator turn, which restores message flow — just bounded by turn latency, not sub-second.

## Development

```sh
git clone https://github.com/Trevor-Mengel/collabcast.git
cd collabcast
npm install
npm link              # makes the `collabcast` command available globally for local dev
npm test
npm run lint
```

Run `npm unlink -g collabcast` to remove the global symlink.

## License

MIT
