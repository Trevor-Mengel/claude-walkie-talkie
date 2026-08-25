# Security policy

## Supported versions

| Version | Supported |
|---------|-----------|
| `0.3.x` | ✅ Current |
| `0.2.x` | ❌ Superseded by the v0.3 security cutover; not maintained |
| `< 0.2` | ❌ Pre-release; not maintained |

Security fixes are released as patch versions (`0.3.1`, `0.3.2`, …) of the latest minor.

`0.3.0` is the version in `package.json` on `main` and has not been tagged or published yet. The trust model below describes that code. Where it differs from the last published tag, the differences are called out under "Closed since v0.2" — and note that `0.2.x` receives no backports: the cutover replaced the identity and authority model wholesale, so its fixes do not exist as patches to the old one.

## Trust model and threat surface

Collabcast runs entirely on your local machine. There is no remote relay, no third-party service, and no cloud component. That said, the package ships three things that execute with your privileges:

1. **A local HTTP service** per namespace, listening on a Unix domain socket at `.collabcast/run/collabcast.sock`. Loopback TCP exists in the config but is disabled by default.
2. **A stdio MCP server** that the agent host spawns on demand and that talks to the service over that socket.
3. **SessionStart and UserPromptSubmit shell hooks** that fire inside agent sessions in any project where `.collabcast/` exists.

The trust boundary is **"any local process running as your user."** Within that boundary:

- **Reaching the socket is not authority.** Every route except `GET /health` and `POST /enroll/exchange` requires a capability presented as `Authorization: Bearer <token>`, verified against the store and the server's namespace, and each route additionally demands a named scope. A local process that can open the socket but holds no capability can learn only that a service is listening.
- **The socket and every credential beside it are owner-only.** `.collabcast/run/` is mode `700`; `hook.secret`, `operator.cred` and the SQLite store are mode `600`. `operator.cred` is refused outright if its mode is readable beyond its owner.
- **A capability is the only way to become someone.** It is minted by `POST /enroll/exchange` against a one-use, short-lived code that exists only because a human approved the hook dialog, or by `POST /delegate` from a root capability where the store enforces scope-subset and expiry-ceiling against the parent row. Revocation cascades over the derivation closure.
- **Tokens appear in exactly one place.** The enrollment/delegation response body. Never a log, never an audit detail (`redactDetail` replaces any `*Token`-keyed value), never an error message.
- **Enrollment refusals are opaque.** A bad secret and an unknown namespace collapse to the same message, so a caller cannot enumerate namespaces or confirm a stolen secret against the wrong project. The audit row records which it really was.

Cross-origin browser attacks are defanged by middleware that rejects any request with an `Origin` header that is present and not literally `null`, and any request whose `Host` (sans port) is not `127.0.0.1`, `localhost` or `::1`.

`claude.ai` web chat cannot reach the service (cloud-only execution, by design).

### Residual risks, stated plainly

- **A local process that can read `.collabcast/run/operator.cred` holds the operator's capability.** File modes are the only thing standing between them; there is no second factor.
- **A local process able to write inside `.collabcast/run/` before the service binds could present its own socket.** Clients confirm the namespace over `/health` before acting on a socket, which closes the "wrong service" case, but not a hostile service that answers with the right namespace.
- **`GET /events` is best-effort.** It replays nothing and survives no restart, so a subscriber cannot distinguish "nothing happened" from "I missed it" across a reconnect. Treat it as a liveness hint, not an audit trail; the audit table is the record.
- **Channel writes and their audit rows are not one transaction.** A file rename cannot join a SQLite transaction. The file is written first, so a crash loses an audit row rather than fabricating one — but a mutation can exist with no row describing it.
- **The operator credential has no in-band re-issue path.** `collabcast start` mints `.collabcast/run/operator.cred` for the uid that owns the runtime directory, and refuses to mint over one it will not honour — so revoking it genuinely locks the CLI out. Getting back in requires deleting the file as that uid. That is the intended property: possession of the 0700 runtime directory is the attestation. It also means an operator who loses filesystem access to the project cannot recover their own capability.

## Reporting a vulnerability

Please **do not** open a public issue for security reports.

Email the maintainer directly: **trevor@cloutdesk.com**

Or use GitHub's private security advisory flow: https://github.com/Trevor-Mengel/collabcast/security/advisories/new

Reports should include:
- Affected version (`collabcast --version`)
- Steps to reproduce
- Expected vs. observed behavior
- Impact assessment (what an attacker could do)

**Never include a token, a capability document, or the contents of `operator.cred` or `hook.secret` in a report.** A principal id, a capability id, an error code and an audit row are enough to reproduce anything.

I'll acknowledge within 72 hours and aim to ship a patch release within 14 days for critical issues. Coordinated disclosure preferred — I'll work with you on the timing.

## Closed since v0.2

The five deferred hardening items from the `v0.2.0` release notes are all addressed on `main`:

- **Unbounded `config --set`.** Every write is now validated with the same `validateConfig` the service and every client use, so the CLI cannot produce a config they would reject — and there is no longer a `permits` array to clobber.
- **`stop` signalling an unverified PID.** `collabcast stop` now confirms over `/health` that the listener serves *this* namespace before it reads the pid file at all, refuses to signal itself, and refuses to signal when a service is answering but its pid file is unreadable.
- **Permits accepting arbitrary `sessionId` strings.** The per-post permit gate is gone entirely. `POST /permits` and `DELETE /permits/:sessionId` answer 404; publishing is the `channel:publish` scope on a verified capability.
- **`node-notifier` invoked with attacker-influenceable strings.** The notifier consumes only the poster's principal id and the enum-validated message type. No message body, alias or reason reaches it.
- **`inbox` trusting whatever answers at the port.** There is no port file to hijack. Clients derive the socket path through the same resolver the service uses, present a capability, and confirm the namespace over `/health`.

Two further v0.2 issues were closed by the same cutover:

- **`GET /sessions/:id/inbox` advanced the addressed session's cursor as a side effect of answering,** with no authentication — so any caller could empty anyone's queue. Reads are now non-mutating and cursors move only for the calling principal.
- **`PATCH /channel/message/:id` never validated the body,** so an edit could write a literal `<!-- walkie:msg … -->` into the file and forge a second message block attributed to whoever the forged marker named. Posting and editing now share exactly the same check.

## Past security advisories

None to date.
