# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.2.x` | ✅ Current |
| `< 0.2`  | ❌ Pre-release; not maintained |

Security fixes are released as patch versions (`0.2.1`, `0.2.2`, …) of the latest minor.

## Trust model and threat surface

Walkie-talkie runs entirely on your local machine. There is no remote relay, no third-party service, and no cloud component. That said, the package ships three things that execute with your privileges:

1. **A local HTTP daemon** bound to `127.0.0.1:<auto-port>` per project, reachable by any local process.
2. **A stdio MCP server** that Claude Code or Claude Desktop spawns on demand and that talks to the daemon over HTTP.
3. **SessionStart and UserPromptSubmit shell hooks** that fire inside Claude Code sessions in any project where `.walkie-talkie/` exists.

The trust boundary is "any local process running as your user." If a malicious local process can reach the daemon's loopback port, it can post messages to your channel (subject to permits). If a malicious local process can write to `.walkie-talkie/server.port`, it can redirect CLI calls (see the deferred hardening note in [docs/api.md](docs/api.md)).

Cross-origin browser attacks are explicitly defanged by middleware that rejects requests with a present, non-null `Origin` header and requests whose `Host` is not `127.0.0.1` or `localhost`.

`claude.ai` web chat cannot reach the daemon (cloud-only execution, by design).

## Reporting a vulnerability

Please **do not** open a public issue for security reports.

Email the maintainer directly: **trevor@cloutdesk.com**

Or use GitHub's private security advisory flow: https://github.com/Trevor-Mengel/claude-walkie-talkie/security/advisories/new

Reports should include:
- Affected version (`walkie --version`)
- Steps to reproduce
- Expected vs. observed behavior
- Impact assessment (what an attacker could do)

I'll acknowledge within 72 hours and aim to ship a patch release within 14 days for critical issues. Coordinated disclosure preferred — I'll work with you on the timing.

## Known deferred hardening items

Documented in the `v0.2.0` release notes; not currently exploited but worth tracking:

- Unbounded `walkie config --set` accepts arbitrary keys (operator can clobber the `permits` array by hand; not a privilege escalation since the operator already has full daemon access)
- `walkie stop` reads `.walkie-talkie/server.pid` and SIGTERMs without verifying the PID belongs to the daemon (a local actor who can write to that file can cause SIGTERM to an arbitrary process owned by your user)
- Permits store accepts arbitrary `sessionId` strings without verifying the session exists (allows pre-grants to nonexistent sessions)
- `node-notifier` invoked with attacker-influenceable strings (largely mitigated by the C1 marker-field validation)
- `walkie inbox` trusts whatever HTTP server responds at `127.0.0.1:<server.port>` without verifying it's the walkie daemon (a hostile local listener at the right port could inject content into the SessionStart hook's agent context)

All five are queued for the v0.2.1 hardening pass.

## Past security advisories

None to date — `v0.2.0` is the first public release.
