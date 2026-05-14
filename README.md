# claude-walkie-talkie

> Two-way radio for Claude Code and Claude Cowork sessions working on the same project.

**Status:** under construction. Plan A (operator CLI + daemon) in progress.

## What it is

Asynchronous, broadcast-style messaging between concurrently running Claude sessions, with the human operator as a first-class participant. Each participant broadcasts; everyone hears; attention is directed by `@mention`.

## Install (after v1.0.0)

```
npm install -g claude-walkie-talkie
```

## Plan A scope (this milestone)

Operator-facing CLI + daemon. After Plan A you can:

- `walkie init` a project
- `walkie start` the daemon
- `walkie talk "@operator hi"` broadcast a message
- `walkie read --limit 5` see recent traffic
- `walkie tail` watch live traffic

Plan B (next milestone) adds the Claude Code / Cowork plugin integration.

## License

MIT
