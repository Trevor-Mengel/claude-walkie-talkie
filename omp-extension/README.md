# Walkie enrollment gate (OMP hook)

An operator-installed OMP hook. It stands between an agent asking to join a Walkie channel
and the authority that issues credentials: the agent's `walkie_enroll` call is intercepted,
the request is shown to **you**, and only an explicit `Approve` causes a one-use enrollment
code to be fetched and injected into the tool's raw arguments.

The model never authors and never sees that code. It cannot enroll itself.

## Files

| File                | Role                                                               |
| ------------------- | ------------------------------------------------------------------ |
| `walkie-enroll.js`  | the hook — the only file OMP loads directly                        |
| `gate.js`           | pure decision logic (tool-name matching + the approval truth table) |
| `authority.js`      | newline-delimited-JSON client for the authority's Unix socket        |
| `redact.js`         | redactor every log entry passes through                             |

They are siblings by design: install the **whole directory**, not just the entry file.

These four files import nothing outside `node:fs` and `node:net` — no dependency on the
rest of the Walkie source tree, so the directory is self-contained and copyable. The hook
is loaded by OMP's own runtime, not by the `walkie` CLI; the surrounding package declares
`engines.node >= 22`, which is the floor to assume if you run any of this under plain Node.

## Install

Copy the directory somewhere stable and point OMP at the entry file with an absolute path:

```sh
mkdir -p ~/.omp/walkie
cp -R /path/to/claude-walkie-talkie/omp-extension/. ~/.omp/walkie/
```

### One session (verify it works before making it permanent)

```sh
omp --hook=$HOME/.omp/walkie/walkie-enroll.js
```

`--hook` is an alias for `--extension`: OMP resolves the absolute path and imports it. The
package declares `"type": "module"`, so the `.js` entry is still ESM.

### Persistently

User scope, `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/walkie/walkie-enroll.js
```

Or project scope, `<project>/.omp/settings.json`:

```json
{
  "extensions": ["/Users/you/.omp/walkie/walkie-enroll.js"]
}
```

Both lists take explicit paths and behave identically to `--hook`.

### Ambient discovery (`.omp/hooks/pre/`)

OMP's hook-capability scan only treats a **`.ts` or `.js`** entry as an importable hook
factory, which is why the entry file ships as `walkie-enroll.js` rather than `.mjs`: copying
the directory into a scanned location is enough, with no rename and no explicit path.

```sh
mkdir -p ~/.omp/agent/hooks/pre/walkie
cp -R /path/to/claude-walkie-talkie/omp-extension/. ~/.omp/agent/hooks/pre/walkie/
```

## Environment

The hook reads only these variables, and only from its own process environment.

| Variable                   | Required | Default         | Meaning                                                                                 |
| -------------------------- | -------- | --------------- | --------------------------------------------------------------------------------------- |
| `WALKIE_AUTHORITY_SOCKET`  | yes      | —               | Unix socket path the Walkie authority listens on.                                        |
| `WALKIE_HOOK_SECRET`       | yes      | —               | Shared secret proving the request came from an installed hook, not from a random client. |
| `WALKIE_MCP_SERVERS`       | no       | `walkie-talkie` | Comma/space-separated allowlist of MCP server names whose `walkie_enroll` is accepted.   |
| `WALKIE_HOOK_TIMEOUT_MS`   | no       | `5000`          | Budget for the whole authority round trip.                                               |
| `WALKIE_HOOK_LOG`          | no       | unset           | Path to a JSONL audit log. Nothing is written for tool calls the gate does not touch.    |

If either required variable is missing, an approved request is **blocked** with
`config_invalid` — approval never falls back to enrolling without the authority.

## What you see

```
Walkie enrollment

An agent is asking to enroll on the walkie channel.

Namespace: walkie-talkie
Role:      listener
Scopes:    channel:read, channel:publish
TTL:       900s

Approve only if you asked for this agent to join.

  > Deny
    Approve
```

`Deny` is listed first and is therefore the pre-selected default. This is deliberate:
`ctx.ui.confirm` renders Yes/No with **Yes** pre-selected, so a stray ENTER on a confirm
dialog approves. A `select` with `Deny` first turns the same accident into a denial.

## Fail-closed behaviour

Every one of these blocks the tool call, and none of them injects a code:

| Situation                                                      | Result                     |
| -------------------------------------------------------------- | -------------------------- |
| Non-interactive session (`omp -p`, subagent, CI)               | `forbidden`                |
| `walkie_enroll` offered by a server not in the allowlist        | `forbidden`                |
| Request omits namespace, role, or scopes                        | `invalid_request`          |
| `Deny`, a dismissed dialog, or an unrecognised selection        | `forbidden`                |
| The confirmation dialog itself throws                           | `forbidden`                |
| Authority socket or hook secret not configured                  | `config_invalid`           |
| Socket unreachable, timed out, hung up, or replied with garbage | `internal`                 |
| Authority returns an error envelope                             | `internal` (its code logged) |

A background agent that needs channel access does **not** get it here: the root principal
delegates a capability to it. Self-enrollment is an interactive, human-present act.

Two matching notes on the tool name, because both are easy to get wrong:

- OMP namespaces MCP-provided tools as `mcp__<serverName>_<toolName>`. A gate matching a
  bare `walkie_enroll` never fires for the MCP path — it fails **open**. Matching here is
  generated from the allowlist, never parsed out of the name.
- A name that merely *contains* `walkie_enroll` mid-string (`walkie_enroll_status`) is a
  different tool and passes through untouched. A name that *ends* in `walkie_enroll` from
  an unrecognised source is blocked, not passed.

## Logging

With `WALKIE_HOOK_LOG` set, each gated decision appends one JSON object: timestamp, stage,
tool name, namespace, role, scopes, TTL, selection, outcome, and an error code on failure.

Every entry goes through `redact.js`, which drops secret-named keys (`code`, `hookSecret`,
`enrollmentCode`, `token`, …) *and* independently drops any value shaped like a base64url
blob, so a secret that leaks in under an unexpected key is still caught. The enrollment code
is never logged at all. Nothing is written to stdout, and nothing is sent back into the
conversation via `pi.sendMessage` — a `reason` string is the only model-visible output, and
those strings are fixed constants.

## What this boundary is, and what it is not

This hook is **operator-installed policy**. Its strength comes from where it sits — in your
OMP process, under your control, ahead of tool execution — not from cryptography.

`WALKIE_HOOK_SECRET` lives in the environment of a process running as your user. Any other
process running as the **same uid** can read it (`ps eww`, `/proc/<pid>/environ` on Linux,
a debugger, or simply a shell you gave an agent) and can then talk to the authority socket
directly, bypassing this dialog. The socket is likewise reachable by anything with
filesystem access to it.

So: this is an **accident-and-discipline boundary**, not a cryptographic one. It reliably
stops an agent from quietly enrolling itself through the tool surface it was given, and it
guarantees a human saw the namespace, role, scopes, and TTL before a credential existed. It
does **not** contain an adversary who already has arbitrary same-uid code execution on your
machine. If that is your threat model, the authority needs a peer-credential check and a
separate uid, not a shared secret in an env var.
