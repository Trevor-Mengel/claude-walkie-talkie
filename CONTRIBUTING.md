# Contributing

Thanks for your interest in collabcast. This is a small, opinionated project — contributions that fit the design philosophy are welcome.

## Design philosophy (read first)

- **One channel per project.** Multiple channels are an explicit non-goal.
- **`src/core/channel.js` is the only writer.** Any path that bypasses it (or the service HTTP that wraps it) breaks the multi-writer correctness guarantee. PRs that bypass it will be rejected.
- **Identity is issued, never asserted.** A client states what it wants to do, never who it is. Author, alias, tool, timestamp, git provenance and resolved mentions are all derived server-side from the calling capability. A PR that adds an identity or authority field to a request body will be rejected — see `LEGACY_AUTHORITY_FIELDS` in `src/daemon/auth.js` for the ones that were removed and are now actively refused.
- **Operator is the human; a human approves the first capability.** Auto-claiming, auto-rotating, auto-anything is an explicit non-goal. Hook enrollment mints `root` and nothing else; everything narrower is delegated, and narrowing is enforced by the store rather than by a check a route could forget.
- **Reads never mutate.** A read is something a client may perform on its own initiative, so it can never consume a cursor. Acknowledging is always explicit.
- **No hard delete.** Archive is the strongest removal.
- **Natural language is the agent's job; the CLI is explicit.** `collabcast ai "..."` will not be added.
- **Fail closed.** A missing prerequisite is a refusal with a named code, not a silent fallback. In `managed` mode a client will not start a service the supervisor doesn't know about; if the enrollment socket cannot bind, the service refuses to serve at all.

## Setup

```sh
git clone https://github.com/Trevor-Mengel/collabcast.git
cd collabcast
npm install
npm link
npm test
npm run lint
```

## Tests

Four layers:

1. **`src/core/` unit tests** — atomic append, ULID monotonicity, parse round-trip, lockfile recovery, marker/body forgery rejection. Highest-risk code.
2. **Store and authority tests** — capability issue/verify/revoke and its narrowing rules, cursor monotonicity, audit rows, enrollment-code redemption and its opaque refusals.
3. **HTTP integration tests** — supertest and real-socket requests against a composed app in a disposable namespace. Cover every route, every scope refusal, and the SSE event vocabulary.
4. **End-to-end harness** (`test/e2e/`) — spawn the service plus mock MCP clients and the operator CLI; walk a full conversation.

Run all: `npm test`. Single file: `npx vitest run test/path/file.test.js`. Watch mode: `npm run test:watch`.

Two rules the harness enforces for you:

- **`test/helpers/isolation.js` runs as a vitest `setupFile` and throws before any test body if the process could reach live user state.** It requires every `COLLABCAST_*` root to name a disposable path and refuses the real `~/.collabcast` and `~/.walkie-talkie`. Do not work around it — build namespaces with `createRegisteredNamespace` or `createStack`.
- **`test/scratch/**` is excluded from the suite** by `vitest.config.js`. Throwaway probes go there or in `/tmp`, never under a collected `test/` path, so a scratch file can't change the suite's file count or exit code.

## Commit conventions

`type(scope): subject` in the imperative. Types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`.

Examples:
- `feat(mcp): collabcast_ack tool with per-view cursor selection`
- `fix(core): round-trip from-tool and timestamp through marker`
- `docs: README rewrite`

## Issue triage

- **Bug:** include the channel state (`cat .collabcast/channel.md`), the activity log (`collabcast logs --tail 50`), the output of `collabcast whoami --json`, and the OS/Node versions. Never paste a token — `whoami` does not emit one, and neither should you.
- **Feature:** describe the operator-facing scenario first. The technical design comes second.

## Code style

- ES modules, Node ≥ 22.
- Prettier-formatted (`npm run format`).
- ESLint clean (`npm run lint`).
- Tests use vitest + supertest. Don't introduce other test frameworks.
- **Every product default lives in `src/config/schema.js`.** Import `DEFAULT_CONFIG` or its helpers rather than repeating a literal.
- **Every error is a `CollabcastError` carrying a code from `ERROR_CODES`** (`src/identity/errors.js`). An unlisted code throws at construction, so it cannot reach a client. Never put a token, a secret, or the path of a credential file into a message or a detail.
- **The `<!-- walkie:… -->` marker prefix and `WALKIE:HEADER_END` are deliberately retained** after the rename to collabcast, and must stay. `isValidMessageBody`'s unforgeability argument is built on that exact literal, and changing it forces a migration of a file that a later change turns into a generated projection anyway. Do not "finish" this rename.

## What's out of scope

Anything that introduces a remote service. Anything that lets a client state its own identity or widen its own authority. Anything that makes a read mutate state. Anything that hides messages from the operator.
