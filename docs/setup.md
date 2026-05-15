# Setup

## Prerequisites

- Node ≥ 18
- macOS, Linux, or Windows (WSL recommended)
- An initialized walkie channel in your project (`walkie init`)

## Install the CLI

```sh
npm install -g claude-walkie-talkie
walkie --version
```

If you prefer not to install globally, run via `npx`:

```sh
npx claude-walkie-talkie walkie init --operator "Your Name"
```

## Install the plugin into Claude Code

From inside Claude Code:

```
/plugin marketplace add trevormengel/claude-walkie-talkie
/plugin install walkie-talkie@claude-walkie-talkie
/reload-plugins
```

The marketplace name (`claude-walkie-talkie`) is the second part of the install command's `@<marketplace>` suffix; the plugin name (`walkie-talkie`) is the first. Both come from `.claude-plugin/marketplace.json` in this repo.

For local development without a marketplace round-trip:

```
/plugin add /path/to/claude-walkie-talkie
```

Code reads `plugin.json` at install time and wires up:

- `skills/walkie-talkie/SKILL.md` — the LLM-facing scenarios
- `hooks/hooks.json` — SessionStart + UserPromptSubmit hooks
- `commands/walkie-inbox.md`, `commands/walkie-talk.md` — slash commands
- `mcp.json` — launches the `walkie-talkie-mcp` server on demand

After install, open a session in any project that has `.walkie-talkie/` and the SKILL.md activates automatically. Run `walkie permit <your-session> --always` once you want the agent to write without prompting each time.

## Install the plugin into Claude Cowork

Same package, same `plugin.json`. Override the MCP environment variable so Cowork registers as `claude-cowork` (not `claude-code`). In your Cowork MCP config:

```json
{
  "mcpServers": {
    "walkie-talkie": {
      "command": "npx",
      "args": ["-y", "claude-walkie-talkie", "walkie-talkie-mcp"],
      "env": { "WALKIE_TOOL": "claude-cowork" }
    }
  }
}
```

### Known limitation: Cowork hooks

Plugin hooks do not currently fire in Claude Cowork due to [anthropics/claude-code#27398](https://github.com/anthropics/claude-code/issues/27398). The walkie-talkie plugin ships them anyway — they activate the moment Anthropic ships the fix. Until then, Cowork picks up inbound messages via the skill, which prompts `walkie_inbox` on every operator turn.

If your Cowork host supports MCP resource subscriptions, the `walkie://channel/inbox` resource will also push refresh notifications as messages arrive — no skill round-trip required.

## Verifying the install

In a freshly cloned project:

```sh
mkdir -p ~/scratch/walkie-verify && cd ~/scratch/walkie-verify
walkie init --operator "You"
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
walkie stop   # in any project that has a running daemon
npm uninstall -g claude-walkie-talkie
# remove the plugin via the host's plugin manager
```

To wipe channel history for a project: `rm -rf path/to/project/.walkie-talkie/`. To wipe machine-wide registry: `rm ~/.walkie-talkie/registry.json`.
