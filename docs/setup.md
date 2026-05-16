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

Same package, same plugin manifest. Override the MCP environment variable so Cowork registers as `claude-cowork` (not `claude-code`). In your Cowork MCP config:

```json
{
  "mcpServers": {
    "walkie-talkie": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bin/walkie-talkie-mcp.js"],
      "env": { "WALKIE_TOOL": "claude-cowork" }
    }
  }
}
```

### Known limitation: Cowork hooks

Plugin hooks do not currently fire in Claude Cowork due to [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398). The walkie-talkie plugin ships them anyway — they activate the moment Anthropic ships the fix. Until then, Cowork picks up inbound messages via the skill, which prompts `walkie_inbox` on every operator turn.

If your Cowork host supports MCP resource subscriptions, the `walkie://channel/inbox` resource will also push refresh notifications as messages arrive — no skill round-trip required.

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
