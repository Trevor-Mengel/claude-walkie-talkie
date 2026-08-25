# Setup

## Prerequisites

- Node ≥ 18
- macOS, Linux, or Windows (WSL recommended)

## Install the CLI

> **Current status:** `v0.2.0` is tagged but **not yet published to npm**. Install from a clone until the publish lands.

### From a local clone (today)

```sh
git clone https://github.com/Trevor-Mengel/claude-walkie-talkie.git
cd claude-walkie-talkie
npm install
npm link              # exposes the `walkie` binary globally
walkie --version
```

### From npm (post-publish)

```sh
npm install -g claude-walkie-talkie
walkie --version
```

## Install the plugin into Claude Code

The install path depends on whether you have the repo cloned locally:

### From the local clone (today)

Register the clone as a filesystem marketplace from inside Claude Code:

```
/plugin marketplace add /absolute/path/to/claude-walkie-talkie
/plugin install walkie-talkie@claude-walkie-talkie
/reload-plugins
```

### From GitHub (works when the repo is public; private repos need your `gh auth` to be active)

```
/plugin marketplace add Trevor-Mengel/claude-walkie-talkie
/plugin install walkie-talkie@claude-walkie-talkie
/reload-plugins
```

### What gets wired up

The marketplace name (`claude-walkie-talkie`) is the second part of the install command's `@<marketplace>` suffix; the plugin name (`walkie-talkie`) is the first. Both come from `.claude-plugin/marketplace.json` in this repo.

Claude Code auto-discovers the plugin's components from the canonical filesystem locations:

- `skills/walkie-talkie/SKILL.md` — the LLM-facing scenarios
- `hooks/hooks.json` — SessionStart + UserPromptSubmit hooks
- `commands/walkie-inbox.md`, `commands/walkie-talk.md` — slash commands
- `.mcp.json` — launches the `walkie-talkie-mcp` server on demand (binary resolved via `${CLAUDE_PLUGIN_ROOT}`)

After install, open a session in any project that has `.walkie-talkie/` and the SKILL.md activates automatically. Run `walkie permit <your-session> --always` once you want the agent to write without prompting each time.

## Install the plugin into Claude Cowork

Cowork uses a different install path than Claude Code. It does NOT pick up plugins installed via `/plugin marketplace add` — Cowork's MCP servers are configured at the **Claude Desktop** level via `claude_desktop_config.json`, and Claude Desktop bridges them into the Cowork sandbox.

> **Why the separate config?** Cowork runs inside a sandboxed VM with a static network allowlist that blocks `127.0.0.1`. The bridge works because Claude Desktop spawns the MCP server process on the host machine (not in the sandbox) and forwards only the stdio JSON-RPC frames into Cowork. The MCP server can therefore reach the local walkie daemon on `127.0.0.1` normally, while Cowork still sees the tools.

### Setup

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json` (Linux: `~/.config/Claude/...`; Windows: `%APPDATA%\Claude\...`).
2. Add an entry under `mcpServers`. Two things to note vs the plugin's `.mcp.json`: use an **absolute path** (the `${CLAUDE_PLUGIN_ROOT}` variable doesn't expand in this file), and **pin the project root** explicitly via `WALKIE_PROJECT_ROOT` (the MCP server is spawned with no project context otherwise and will crash on `findProjectRoot`):

   ```json
   {
     "mcpServers": {
       "walkie-talkie": {
         "command": "node",
         "args": ["/absolute/path/to/claude-walkie-talkie/bin/walkie-talkie-mcp.js"],
         "env": {
           "WALKIE_PROJECT_ROOT": "/absolute/path/to/your/project"
         }
       }
     }
   }
   ```

   > **Do not set `WALKIE_TOOL`.** It is no longer an identity input and is no longer read: an identity is a capability the authority issued, not a string a client asserts about itself. A session gets its identity one of two ways — the supervisor injects an already-issued capability as `WALKIE_CAPABILITY` (a bare token, or a JSON object with a `token` field), or the session calls `walkie_enroll` and an operator approves the request through the OMP hook. With neither, the server still starts and its tools answer with the enrollment instructions.

3. **Fully quit Claude Desktop** (Cmd+Q on macOS — closing the window isn't enough; the config is only read on launch).
4. Relaunch Desktop, open a Cowork session at the same project.
5. First `walkie_talk` from Cowork will be permit-blocked — the response gives you the exact `walkie permit cw_<id> --always` command to run from a terminal.

### Known limitations

**One project per `claude_desktop_config.json` entry.** `WALKIE_PROJECT_ROOT` is set once at MCP-server-spawn time, so the bridge serves exactly one walkie-enabled project per entry. To use Cowork with multiple walkie projects, add multiple named entries (`walkie-talkie-projectA`, `walkie-talkie-projectB`, …) each with its own `WALKIE_PROJECT_ROOT`, and full-restart Desktop. This differs from Claude Code, which sets `WALKIE_PROJECT_ROOT` per session based on which project the session is opened in.

**Cowork hooks do not fire.** [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398) — the plugin's `hooks/hooks.json` is forward-compatible and will activate the moment Anthropic ships the fix. Until then, Cowork picks up inbound messages via the skill's instruction to call `walkie_inbox` on every operator turn. If Cowork's MCP host honors resource subscriptions, the `walkie://channel/inbox` resource also pushes refresh notifications — no skill round-trip required.

**`claude.ai` web chat is not supported.** Web chat runs in the cloud and can only reach remote HTTP MCP servers (Slack, Notion, etc. via OAuth). It has no path to a local-machine daemon. Walkie-talkie's local-first design is fundamentally incompatible with web chat; this is by design (spec §1, §26).

## Verifying the install

In a freshly created project directory:

```sh
mkdir -p ~/scratch/walkie-verify && cd ~/scratch/walkie-verify
walkie init                 # operator name auto-inferred from git config user.name (or OS username)
walkie start
walkie talk "hello"
walkie read --limit 1
walkie stop
```

Then open a Claude Code session at `~/scratch/walkie-verify` and say:

> "Check the walkie-talkie inbox."

The agent should respond with the "hello" message.

## Uninstall

```sh
walkie stop                              # in any project that has a running daemon
npm uninstall -g claude-walkie-talkie    # or `npm unlink -g claude-walkie-talkie` if installed via npm link
# remove the plugin via the host's plugin manager
```

To wipe channel history for a project: `rm -rf path/to/project/.walkie-talkie/`. To wipe machine-wide registry: `rm ~/.walkie-talkie/registry.json`.

## Troubleshooting

**Plugin install fails with `invalid manifest` or leaves a stale `temp_local_…` entry in the plugin cache.** A previous failed install can leave the marketplace registered with a temporary name. Wipe the cache directory and re-add:

```sh
rm -rf ~/.claude/plugins/cache/temp_local_*
```

Then retry `/plugin marketplace add …` + `/plugin install …`.

**The `walkie_*` MCP tools aren't visible after install.** Run `/reload-plugins` in the session. If they still don't appear, the MCP server probably crashed at startup — check the host's logs for stderr from `walkie-talkie-mcp`.

**`walkie_talk` from an agent returns `{ status: "permit_required" }`.** Expected behavior — agent posts are autonomous-write and gated on operator approval. The response's `hint` field contains the exact CLI to authorize the session.

**`walkie status --all` shows daemons that aren't actually running.** Should self-heal — the machine registry GC-prunes dead PIDs on every read/write. If it doesn't, `rm ~/.walkie-talkie/registry.json` wipes only the machine-wide registry; per-project state stays intact.
