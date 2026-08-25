# Setup

## Prerequisites

- Node ≥ 22
- macOS, Linux, or Windows (WSL recommended)

## Install the CLI

> **Current status:** not yet published to npm. Install from a clone until the publish lands.

### From a local clone (today)

```sh
git clone https://github.com/Trevor-Mengel/collabcast.git
cd collabcast
npm install
npm link              # exposes the `collabcast` binary globally
collabcast --version
```

### From npm (post-publish)

```sh
npm install -g collabcast
collabcast --version
```

## Install the plugin into Claude Code

The install path depends on whether you have the repo cloned locally:

### From the local clone (today)

Register the clone as a filesystem marketplace from inside Claude Code:

```
/plugin marketplace add /absolute/path/to/collabcast
/plugin install collabcast@collabcast
/reload-plugins
```

### From GitHub (works when the repo is public; private repos need your `gh auth` to be active)

```
/plugin marketplace add Trevor-Mengel/collabcast
/plugin install collabcast@collabcast
/reload-plugins
```

### What gets wired up

Both halves of `@<marketplace>` come from `.claude-plugin/marketplace.json` in this repo: the marketplace name is the top-level `name` and the plugin name is `plugins[0].name`. Both are `collabcast`, which is why the command reads `collabcast@collabcast`.

Claude Code auto-discovers the plugin's components from the canonical filesystem locations:

- `skills/collabcast/SKILL.md` — the LLM-facing scenarios
- `hooks/hooks.json` — SessionStart + UserPromptSubmit hooks
- `commands/collabcast-inbox.md`, `commands/collabcast-talk.md` — the `/collabcast-inbox` and `/collabcast-talk` slash commands
- `.mcp.json` — launches the `collabcast-mcp` server on demand (binary resolved via `${CLAUDE_PLUGIN_ROOT}`)

After install, open a session in any project that has `.collabcast/` and the SKILL.md activates automatically. The session starts with no capability; its first tool call answers `unauthenticated`, and it acquires authority by calling `collabcast_enroll` and having you approve the request. There is no per-post approval after that.

## Install the plugin into Claude Cowork

Cowork uses a different install path than Claude Code. It does NOT pick up plugins installed via `/plugin marketplace add` — Cowork's MCP servers are configured at the **Claude Desktop** level via `claude_desktop_config.json`, and Claude Desktop bridges them into the Cowork sandbox.

> **Why the separate config?** Cowork runs inside a sandboxed VM that cannot reach the host's loopback interface or its Unix sockets. The bridge works because Claude Desktop spawns the MCP server process on the host machine (not in the sandbox) and forwards only the stdio JSON-RPC frames into Cowork. The MCP server can therefore reach the local service over `.collabcast/run/collabcast.sock` normally, while Cowork still sees the tools.

### Setup

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json` (Linux: `~/.config/Claude/...`; Windows: `%APPDATA%\Claude\...`).
2. Add an entry under `mcpServers`. Two things to note vs the plugin's `.mcp.json`: use an **absolute path** (the `${CLAUDE_PLUGIN_ROOT}` variable doesn't expand in this file), and **pin the project root** explicitly via `COLLABCAST_PROJECT_ROOT` (the MCP server is spawned with no project context otherwise and will fail in `findProjectRoot`):

   ```json
   {
     "mcpServers": {
       "collabcast": {
         "command": "node",
         "args": ["/absolute/path/to/collabcast/bin/collabcast-mcp.js"],
         "env": {
           "COLLABCAST_PROJECT_ROOT": "/absolute/path/to/your/project"
         }
       }
     }
   }
   ```

   > **Do not set `COLLABCAST_TOOL`.** It is no longer an identity input and is no longer read: an identity is a capability the authority issued, not a string a client asserts about itself. A session gets its identity one of two ways — the supervisor injects an already-issued capability as `COLLABCAST_CAPABILITY` (a bare token, or a JSON object with a `token` field), or the session calls `collabcast_enroll` and an operator approves the request through the OMP hook. With neither, the server still starts and its tools answer with the enrollment instructions.

3. **Fully quit Claude Desktop** (Cmd+Q on macOS — closing the window isn't enough; the config is only read on launch).
4. Relaunch Desktop, open a Cowork session at the same project.
5. The session's first tool call answers `unauthenticated`. Have it call `collabcast_enroll`, approve the request, and it holds a capability for the life of that process.

### Known limitations

**One project per `claude_desktop_config.json` entry.** `COLLABCAST_PROJECT_ROOT` is set once at MCP-server-spawn time, so the bridge serves exactly one collabcast-enabled project per entry. To use Cowork with multiple projects, add multiple named entries (`collabcast-projectA`, `collabcast-projectB`, …) each with its own `COLLABCAST_PROJECT_ROOT`, and full-restart Desktop. This differs from Claude Code, which sets `COLLABCAST_PROJECT_ROOT` per session based on which project the session is opened in.

**Cowork hooks do not fire.** [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398) — the plugin's `hooks/hooks.json` is forward-compatible and will activate the moment Anthropic ships the fix. Until then, Cowork picks up inbound messages via the skill's instruction to call `collabcast_inbox` on every operator turn. If Cowork's MCP host honors resource subscriptions, the `collabcast://channel/inbox` resource also pushes refresh notifications — no skill round-trip required.

**`claude.ai` web chat is not supported.** Web chat runs in the cloud and can only reach remote HTTP MCP servers. It has no path to a local Unix socket. Collabcast's local-first design is fundamentally incompatible with web chat; this is by design.

## Verifying the install

In a freshly created project directory. Note `--mode standalone`: the default `managed` mode expects a supervisor to own the service lifecycle, and clients deliberately refuse to start one themselves.

```sh
mkdir -p ~/scratch/collabcast-verify && cd ~/scratch/collabcast-verify && git init -q
collabcast init --mode standalone   # operator name auto-inferred from git config user.name (or OS username)
collabcast start
collabcast whoami
collabcast talk "hello"
collabcast status
collabcast stop
```

`whoami` reporting a `role: operator` capability is the install check: `start` mints the operator credential at `.collabcast/run/operator.cred` (mode `600`), which is what every command past `init` authenticates with. A restart never rotates it.

Then open an agent session at `~/scratch/collabcast-verify` and say:

> "Check the collabcast inbox."

The agent should enroll (with your approval) and report an empty inbox.

## Uninstall

```sh
collabcast stop                    # in any standalone-mode project with a running service
npm uninstall -g collabcast        # or `npm unlink -g collabcast` if installed via npm link
# remove the plugin via the host's plugin manager
```

To wipe channel history for a project: `rm -rf path/to/project/.collabcast/`. To drop a project from the host identity map, remove its entry from `~/.collabcast/identities.json`.

## Troubleshooting

**Plugin install fails with `invalid manifest` or leaves a stale `temp_local_…` entry in the plugin cache.** A previous failed install can leave the marketplace registered with a temporary name. Wipe the cache directory and re-add:

```sh
rm -rf ~/.claude/plugins/cache/temp_local_*
```

Then retry `/plugin marketplace add …` + `/plugin install …`.

**The `collabcast_*` MCP tools aren't visible after install.** Run `/reload-plugins` in the session. If they still don't appear, the MCP server probably crashed at startup — check the host's logs for stderr from `collabcast-mcp`.

**Every tool call returns `{ error: { code: "unauthenticated" } }`.** Expected on a fresh session. The `hint` field says to call `collabcast_enroll`; approving the resulting dialog issues the capability. If the dialog never appears, the enrollment socket is not reachable — check that `.collabcast/run/authority.sock` exists and that `.collabcast/run/` is mode `700`.

**Tool calls return `{ error: { code: "unavailable" } }`.** Nothing is listening on the namespace socket. In `standalone` mode, run `collabcast start`. In `managed` mode, start it through the supervisor — clients fail closed rather than spawning a service the supervisor doesn't know about.

**A tool call returns `{ error: { code: "scope_required" } }`.** The session authenticated but its capability was never granted that scope. Scopes are fixed at issue time and can only narrow, so this needs a new capability — a `listener`, for example, holds `channel:read` but not `channel:publish`.

**`collabcast status --all` lists namespaces you no longer use.** The host identity map at `~/.collabcast/identities.json` is the registry; remove the stale entry there. Per-project state under each project's `.collabcast/` is independent.
