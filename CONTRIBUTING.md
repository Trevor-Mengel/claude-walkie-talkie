# Contributing

Thanks for your interest in walkie-talkie. This is a small, opinionated project — contributions that fit the design philosophy are welcome.

## Design philosophy (read first)

- **One channel per project.** Multiple channels are an explicit non-goal (see spec §26).
- **Walkie-core is the only writer.** Any path that bypasses `src/core/channel.js` (or the daemon HTTP that wraps it) breaks the multi-writer correctness guarantee. PRs that bypass it will be rejected.
- **Operator is the human, sessions are agents.** The operator is always in the loop for autonomous writes. Auto-claiming, auto-rotating, auto-anything is an explicit non-goal.
- **No hard delete.** Archive is the strongest removal.
- **Natural language is the agent's job; the CLI is explicit.** `walkie ai "..."` will not be added.

## Setup

```sh
git clone https://github.com/trevormengel/claude-walkie-talkie.git
cd claude-walkie-talkie
npm install
npm link
npm test
npm run lint
```

## Tests

Three layers:

1. **`src/core/` unit tests** — atomic append, ULID monotonicity, parse round-trip, lockfile recovery. Highest-risk code.
2. **HTTP server integration tests** — supertest against a real daemon in a tmp project. Cover every route and SSE event.
3. **End-to-end harness** (`test/e2e/`) — spawn daemon + two mock MCP clients + operator CLI; walk a full conversation.

Run all: `npm test`. Single file: `npx vitest run test/path/file.test.js`. Watch mode: `npm run test:watch`.

## Commit conventions

`type(scope): subject` in the imperative. Types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`.

Examples:
- `feat(mcp): walkie_talk tool with autonomous flag and permit handling`
- `fix(core): round-trip from-tool and timestamp through marker`
- `docs: README rewrite`

## Issue triage

- **Bug:** include the channel state (`cat .walkie-talkie/channel.md`), the daemon log (`walkie logs --tail 50`), and the OS/Node versions.
- **Feature:** describe the operator-facing scenario first. The technical design comes second.

## Code style

- ES modules, Node ≥ 18.
- Prettier-formatted (`npm run format`).
- ESLint clean (`npm run lint`).
- Tests use vitest + supertest. Don't introduce other test frameworks.

## What's out of scope

See spec §26 for the canonical list. The short version: anything that introduces a remote service, anything that lets agents act without operator approval, anything that hides messages from the operator.
