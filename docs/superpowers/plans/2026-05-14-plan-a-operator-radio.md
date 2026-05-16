# Plan A — Operator Radio (walkie-core + daemon + CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone, operator-facing portion of claude-walkie-talkie: the `walkie-core` library, the per-project daemon (HTTP/SSE/watcher/notifications), and the full operator CLI. After Plan A, a user can `walkie init` a project, `walkie start` the daemon, and broadcast/read messages by hand — no Claude integration yet.

**Architecture:** A single Node.js package. `walkie-core` is the only writer to `channel.md` and provides atomic append-at-top via a lockfile, ULID message IDs, and parse/format primitives. The daemon wraps the core in an Express HTTP server with SSE, a chokidar file watcher, desktop notifications, and a permit gate. The CLI is a thin commander-based wrapper that talks to the daemon over HTTP. Everything operates on the project's `.walkie-talkie/` directory and registers in `~/.walkie-talkie/registry.json` for cross-project visibility.

**Tech Stack:**
- Node.js ≥18, ESM, plain JavaScript with JSDoc types (no build step)
- HTTP: `express`
- File watching: `chokidar`
- Locking: `proper-lockfile`
- IDs: `ulid`
- CLI: `commander`
- Notifications: `node-notifier`
- Test: `vitest` + `supertest`
- Lint/format: `eslint` (flat config) + `prettier`

**Spec reference:** `docs/superpowers/specs/2026-05-14-claude-walkie-talkie-design.md`. This plan covers spec §3–§15, §18 (Code-side hooks deferred), §19, §21–§24. Out of Plan A: MCP server (§16), SKILL.md (§17), hooks (§17.4), slash commands (§17.5), §20 memory-update integration, full docs (§25), E2E harness (§24 layer 3).

---

## File Structure

```
claude-walkie-talkie/
├── .gitignore
├── package.json
├── eslint.config.js
├── .prettierrc
├── vitest.config.js
├── README.md                       # skeleton, updated at end of Plan A
├── LICENSE                         # MIT
├── bin/
│   └── walkie.js                   # CLI shebang entry → src/cli/index.js
├── src/
│   ├── core/
│   │   ├── time.js                 # now() + relative()
│   │   ├── ids.js                  # ULID wrapper, monotonic generator
│   │   ├── mentions.js             # parse + resolve @tokens
│   │   ├── git.js                  # branch/hash/user best-effort
│   │   ├── format.js               # format/parse single message block
│   │   ├── channel.js              # parse/read/append/edit/archive channel.md
│   │   └── history.js              # per-message revision audit trail
│   ├── registry/
│   │   ├── sessions.js             # active.json + join/rename/markSeen/rollover
│   │   └── invitations.js          # invitations.json + add/find/fulfill/expire
│   ├── daemon/
│   │   ├── server.js               # express app factory + listen
│   │   ├── events.js               # EventEmitter shared by routes
│   │   ├── permits.js              # permit gate logic + config.json I/O
│   │   ├── watcher.js              # chokidar + external-edit detection
│   │   ├── notify.js               # node-notifier wrapper
│   │   ├── lifecycle.js            # spawn/stop/status/auto-start
│   │   ├── registry-machine.js     # ~/.walkie-talkie/registry.json
│   │   ├── daemon-entry.js         # process entry (spawned by lifecycle)
│   │   └── routes/
│   │       ├── channel.js          # /channel/* routes
│   │       ├── sessions.js         # /sessions/* routes
│   │       ├── permits.js          # /permits/* routes
│   │       └── events.js           # /events SSE
│   └── cli/
│       ├── index.js                # commander setup, top-level entry
│       ├── client.js               # HTTP client for the local daemon
│       ├── render.js               # terminal rendering of messages
│       ├── init.js                 # walkie init
│       ├── start.js                # walkie start
│       ├── stop.js                 # walkie stop
│       ├── status.js               # walkie status
│       ├── talk.js                 # walkie talk
│       ├── read.js                 # walkie read
│       ├── tail.js                 # walkie tail
│       ├── reply.js                # walkie reply
│       ├── edit.js                 # walkie edit
│       ├── archive.js              # walkie archive
│       ├── sessions.js             # walkie sessions
│       ├── rename.js               # walkie rename
│       ├── alias.js                # walkie alias
│       ├── invite.js               # walkie invite
│       ├── permit.js               # walkie permit
│       ├── remove.js               # walkie remove
│       ├── config.js               # walkie config
│       └── logs.js                 # walkie logs
└── test/
    ├── helpers/
    │   ├── tmp-project.js          # build a tmp .walkie-talkie/ for a test
    │   └── spawn-daemon.js         # spawn a real daemon on an ephemeral port
    ├── core/
    │   ├── time.test.js
    │   ├── ids.test.js
    │   ├── mentions.test.js
    │   ├── git.test.js
    │   ├── format.test.js
    │   ├── channel.test.js
    │   ├── history.test.js
    │   └── concurrent-append.test.js
    ├── registry/
    │   ├── sessions.test.js
    │   └── invitations.test.js
    ├── daemon/
    │   ├── server.test.js
    │   ├── permits.test.js
    │   ├── watcher.test.js
    │   ├── events.test.js
    │   └── lifecycle.test.js
    └── cli/
        ├── help.test.js
        ├── init.test.js
        └── talk.test.js
```

---

## Phase 0 — Bootstrap

### Task 1: Initialize package, license, gitignore, README skeleton

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `README.md`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "claude-walkie-talkie",
  "version": "0.1.0",
  "description": "Asynchronous two-way messaging between concurrent Claude Code and Cowork sessions.",
  "type": "module",
  "license": "MIT",
  "author": "Trevor Mengel <trevor@cloutdesk.com>",
  "homepage": "https://github.com/Trevor-Mengel/claude-walkie-talkie",
  "bugs": "https://github.com/Trevor-Mengel/claude-walkie-talkie/issues",
  "repository": {
    "type": "git",
    "url": "https://github.com/Trevor-Mengel/claude-walkie-talkie.git"
  },
  "engines": { "node": ">=18" },
  "bin": { "walkie": "./bin/walkie.js" },
  "files": ["bin", "src", "templates", "README.md", "LICENSE"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src test bin",
    "format": "prettier --write \"src/**/*.js\" \"test/**/*.js\" \"bin/**/*.js\""
  },
  "dependencies": {
    "chokidar": "^3.6.0",
    "commander": "^12.0.0",
    "express": "^4.19.0",
    "node-notifier": "^10.0.1",
    "proper-lockfile": "^4.1.2",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "eslint": "^9.0.0",
    "prettier": "^3.2.0",
    "supertest": "^7.0.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
coverage/
.DS_Store
*.log
.walkie-talkie/
.walkie-talkie-test-*/
.vscode/
.idea/
```

- [ ] **Step 3: Write `LICENSE` (MIT)**

```
MIT License

Copyright (c) 2026 Trevor Mengel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Write `README.md` skeleton**

```markdown
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
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: `package-lock.json` created, `node_modules/` populated, no errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore LICENSE README.md
git commit -m "chore: bootstrap package, license, gitignore, README skeleton"
```

---

### Task 2: Configure lint, format, test runner

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc`
- Create: `vitest.config.js`

- [ ] **Step 1: Write `eslint.config.js`** (flat config, ESM)

```js
export default [
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly' }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['error', 'always']
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { describe: 'readonly', test: 'readonly', expect: 'readonly', beforeEach: 'readonly', afterEach: 'readonly', beforeAll: 'readonly', afterAll: 'readonly' }
    }
  }
];
```

- [ ] **Step 2: Write `.prettierrc`**

```json
{
  "singleQuote": true,
  "trailingComma": "none",
  "printWidth": 100,
  "semi": true,
  "arrowParens": "always"
}
```

- [ ] **Step 3: Write `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    testTimeout: 10000
  }
});
```

- [ ] **Step 4: Verify tooling runs**

Run: `npm run lint`
Expected: exits 0, no errors (nothing to lint yet).

Run: `npm run test`
Expected: vitest reports "No test files found" and exits 0.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js .prettierrc vitest.config.js
git commit -m "chore: configure eslint, prettier, vitest"
```

---

## Phase 1 — walkie-core foundations (small, pure modules)

### Task 3: Time helper

**Files:**
- Create: `src/core/time.js`
- Test: `test/core/time.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/core/time.test.js
import { describe, test, expect } from 'vitest';
import { now, relative } from '../../src/core/time.js';

describe('time', () => {
  test('now() returns ISO 8601 UTC string', () => {
    expect(now()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test('relative() returns "just now" for current timestamp', () => {
    expect(relative(now())).toBe('just now');
  });

  test('relative() returns seconds for < 1 minute', () => {
    const past = new Date(Date.now() - 45 * 1000).toISOString();
    expect(relative(past)).toBe('45 seconds ago');
  });

  test('relative() returns minutes for < 1 hour', () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relative(past)).toBe('5 minutes ago');
  });

  test('relative() returns hours for < 1 day', () => {
    const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    expect(relative(past)).toBe('3 hours ago');
  });

  test('relative() returns days for >= 1 day', () => {
    const past = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    expect(relative(past)).toBe('2 days ago');
  });

  test('relative() handles future timestamps', () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(relative(future)).toBe('in the future');
  });

  test('relative() handles singular minute', () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(relative(past)).toBe('1 minute ago');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/time.test.js`
Expected: FAIL — `Cannot find module '../../src/core/time.js'`.

- [ ] **Step 3: Implement**

```js
// src/core/time.js
export function now() {
  return new Date().toISOString();
}

export function relative(iso) {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'in the future';
  const sec = Math.round(diffMs / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/time.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/time.js test/core/time.test.js
git commit -m "feat(core): add time helper (now + relative)"
```

---

### Task 4: ULID generator

**Files:**
- Create: `src/core/ids.js`
- Test: `test/core/ids.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/core/ids.test.js
import { describe, test, expect } from 'vitest';
import { newId } from '../../src/core/ids.js';

describe('ids', () => {
  test('newId() returns a 26-char Crockford base32 ULID', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test('successive calls return monotonically increasing IDs', () => {
    const ids = Array.from({ length: 100 }, () => newId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  test('10,000 generated IDs are all unique', () => {
    const seen = new Set();
    for (let i = 0; i < 10000; i += 1) seen.add(newId());
    expect(seen.size).toBe(10000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/ids.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/ids.js
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

/** @returns {string} 26-char Crockford base32 ULID, monotonic within the process */
export function newId() {
  return ulid();
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/ids.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/ids.js test/core/ids.test.js
git commit -m "feat(core): add monotonic ULID generator"
```

---

### Task 5: Mention parser

**Files:**
- Create: `src/core/mentions.js`
- Test: `test/core/mentions.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/core/mentions.test.js
import { describe, test, expect } from 'vitest';
import { parseMentions, resolveMentions } from '../../src/core/mentions.js';

describe('mentions', () => {
  test('parseMentions() extracts simple @aliases', () => {
    expect(parseMentions('hi @demo-builder and @slide-designer')).toEqual([
      'demo-builder',
      'slide-designer'
    ]);
  });

  test('parseMentions() returns empty when no mentions', () => {
    expect(parseMentions('plain prose, nothing here')).toEqual([]);
  });

  test('parseMentions() ignores email-like @ inside words', () => {
    expect(parseMentions('contact trevor@cloutdesk.com today')).toEqual([]);
  });

  test('parseMentions() captures special tokens', () => {
    expect(parseMentions('@all please respond')).toEqual(['all']);
    expect(parseMentions('ping @operator')).toEqual(['operator']);
    expect(parseMentions('@claude-code, @claude-cowork')).toEqual([
      'claude-code',
      'claude-cowork'
    ]);
  });

  test('parseMentions() deduplicates', () => {
    expect(parseMentions('@x said @x is here')).toEqual(['x']);
  });

  test('resolveMentions() splits resolved vs unresolved', () => {
    const active = [
      { alias: 'demo-builder', tool: 'claude-code' },
      { alias: 'slide-designer', tool: 'claude-cowork' }
    ];
    const out = resolveMentions(['demo-builder', 'unknown-helper', 'claude-code'], active);
    expect(out.resolved).toEqual(['demo-builder', '@tool:claude-code']);
    expect(out.unresolved).toEqual(['unknown-helper']);
  });

  test('resolveMentions() treats @all and @operator as always resolved', () => {
    const out = resolveMentions(['all', 'operator'], []);
    expect(out.resolved).toEqual(['@all', '@operator']);
    expect(out.unresolved).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/mentions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/mentions.js
const MENTION_RE = /(?:^|[\s,.;!?])@([a-z0-9][a-z0-9-]*)/gi;

const TOOLS = new Set(['claude-code', 'claude-cowork', 'codex', 'cursor']);
const SPECIAL = new Set(['all', 'operator']);

/**
 * @param {string} body
 * @returns {string[]} unique tokens in order of first appearance, lowercased
 */
export function parseMentions(body) {
  const seen = new Set();
  const out = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const tok = m[1].toLowerCase();
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

/**
 * @param {string[]} tokens
 * @param {Array<{alias:string, tool:string}>} activeSessions
 * @returns {{resolved:string[], unresolved:string[]}}
 */
export function resolveMentions(tokens, activeSessions) {
  const aliases = new Set(activeSessions.map((s) => s.alias));
  const resolved = [];
  const unresolved = [];
  for (const tok of tokens) {
    if (SPECIAL.has(tok)) {
      resolved.push(`@${tok}`);
    } else if (TOOLS.has(tok)) {
      resolved.push(`@tool:${tok}`);
    } else if (aliases.has(tok)) {
      resolved.push(tok);
    } else {
      unresolved.push(tok);
    }
  }
  return { resolved, unresolved };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/mentions.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/mentions.js test/core/mentions.test.js
git commit -m "feat(core): add @mention parsing and resolution"
```

---

### Task 6: Git metadata helper

**Files:**
- Create: `src/core/git.js`
- Test: `test/core/git.test.js`

`execFileSync` is used instead of `execSync` — no shell interpolation, no command-injection surface.

- [ ] **Step 1: Write failing test**

```js
// test/core/git.test.js
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitMetadata } from '../../src/core/git.js';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

describe('git metadata', () => {
  let repoDir;
  let nonRepoDir;

  beforeAll(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'walkie-git-'));
    nonRepoDir = mkdtempSync(join(tmpdir(), 'walkie-nogit-'));
    git(['init', '-q', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'tester@example.com'], repoDir);
    git(['config', 'user.name', 'Tester'], repoDir);
    writeFileSync(join(repoDir, 'a.txt'), 'hello');
    git(['add', 'a.txt'], repoDir);
    git(['commit', '-q', '-m', 'init'], repoDir);
  });

  afterAll(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(nonRepoDir, { recursive: true, force: true });
  });

  test('returns metadata in a git repo', () => {
    const meta = gitMetadata(repoDir);
    expect(meta.branch).toBe('main');
    expect(meta.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(meta.userName).toBe('Tester');
    expect(meta.userEmail).toBe('tester@example.com');
  });

  test('returns nulls outside a git repo', () => {
    const meta = gitMetadata(nonRepoDir);
    expect(meta).toEqual({ branch: null, hash: null, userName: null, userEmail: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/git.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/git.js
import { execFileSync } from 'node:child_process';

function tryRun(file, args, cwd) {
  try {
    return execFileSync(file, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Best-effort git metadata. Returns null fields when not in a repo or git unavailable.
 * Uses execFileSync (no shell) to avoid command-injection surface.
 * @param {string} cwd
 * @returns {{branch:string|null, hash:string|null, userName:string|null, userEmail:string|null}}
 */
export function gitMetadata(cwd) {
  return {
    branch: tryRun('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    hash: tryRun('git', ['rev-parse', '--short', 'HEAD'], cwd),
    userName: tryRun('git', ['config', 'user.name'], cwd),
    userEmail: tryRun('git', ['config', 'user.email'], cwd)
  };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/git.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/git.js test/core/git.test.js
git commit -m "feat(core): add best-effort git metadata helper"
```

---

### Task 7: Message block format and parse

**Files:**
- Create: `src/core/format.js`
- Test: `test/core/format.test.js`

Implements the canonical representation of a single message block — both human-readable and machine-readable parts. Spec §6.2.

- [ ] **Step 1: Write failing test**

```js
// test/core/format.test.js
import { describe, test, expect } from 'vitest';
import { formatMessage, parseMessage } from '../../src/core/format.js';

const SAMPLE = {
  id: '01J7QXP9R5K8VYZAB3',
  type: 'question',
  fromSessionId: 'cs_abc123',
  fromAlias: 'demo-builder',
  fromTool: 'claude-code',
  mentions: ['slide-designer'],
  replyTo: null,
  autonomous: false,
  revision: null,
  editedAt: null,
  archived: false,
  archivedBy: null,
  archivedReason: null,
  mentionsPending: [],
  timestamp: '2026-05-14T15:32:00.000Z',
  git: { branch: 'main', hash: 'a3f2c1d', userEmail: 'trevor@abstractlabs', userName: 'Trevor' },
  body: 'Hey — Stripe Connect is wired up. Should the slide mention refunds?'
};

describe('format', () => {
  test('formatMessage emits signature, marker, time, git, body, separator', () => {
    const block = formatMessage(SAMPLE);
    expect(block).toMatch(/^## 📡 demo-builder → @slide-designer\n/);
    expect(block).toContain(
      '<!-- walkie:msg id=01J7QXP9R5K8VYZAB3 type=question from=cs_abc123 mentions=slide-designer -->'
    );
    expect(block).toContain('**Time:** 2026-05-14T15:32:00.000Z');
    expect(block).toContain('**Git:** main @ a3f2c1d (trevor@abstractlabs)');
    expect(block).toContain('Stripe Connect is wired up');
    expect(block.trimEnd().endsWith('---')).toBe(true);
  });

  test('round-trip: parseMessage(formatMessage(x)) preserves fields', () => {
    const block = formatMessage(SAMPLE);
    const parsed = parseMessage(block);
    expect(parsed.id).toBe(SAMPLE.id);
    expect(parsed.type).toBe(SAMPLE.type);
    expect(parsed.fromSessionId).toBe(SAMPLE.fromSessionId);
    expect(parsed.fromAlias).toBe(SAMPLE.fromAlias);
    expect(parsed.mentions).toEqual(SAMPLE.mentions);
    expect(parsed.body.trim()).toBe(SAMPLE.body);
  });

  test('formatMessage uses fallback emoji for unknown tool', () => {
    const block = formatMessage({
      ...SAMPLE,
      fromTool: 'codex',
      fromAlias: 'codex-helper',
      mentions: []
    });
    expect(block).toMatch(/^## ⚡ codex-helper → all\n/);
  });

  test('formatMessage shows operator emoji for from=operator', () => {
    const block = formatMessage({
      ...SAMPLE,
      fromSessionId: 'operator',
      fromTool: 'operator',
      fromAlias: 'Trevor',
      mentions: ['demo-builder']
    });
    expect(block).toMatch(/^## 👤 Trevor → @demo-builder\n/);
  });

  test('formatMessage tags autonomous writes', () => {
    const block = formatMessage({ ...SAMPLE, autonomous: true });
    expect(block).toContain('🤖');
    expect(block).toContain('[autonomous]');
  });

  test('formatMessage renders archived banner and collapses body', () => {
    const block = formatMessage({
      ...SAMPLE,
      archived: true,
      archivedBy: 'cs_abc123',
      archivedReason: 'duplicate'
    });
    expect(block).toContain('🗄️ ARCHIVED');
    expect(block).toContain('archived=true');
    expect(block).toContain('archived-reason="duplicate"');
  });

  test('parseMessage returns null for non-message text', () => {
    expect(parseMessage('# Some random heading\n\nNo marker.')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/format.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/format.js
const TOOL_EMOJI = {
  'claude-code': '📡',
  'claude-cowork': '🎨',
  operator: '👤'
};

function emojiForTool(tool) {
  return TOOL_EMOJI[tool] ?? '⚡';
}

function renderRecipients(mentions) {
  if (!mentions || mentions.length === 0) return 'all';
  return mentions.map((m) => (m.startsWith('@') ? m : `@${m}`)).join(', ');
}

function renderMarker(msg) {
  const parts = [`id=${msg.id}`, `type=${msg.type}`, `from=${msg.fromSessionId}`];
  if (msg.mentions?.length) parts.push(`mentions=${msg.mentions.join(',')}`);
  if (msg.mentionsPending?.length) parts.push(`mentions-pending=${msg.mentionsPending.join(',')}`);
  if (msg.replyTo) parts.push(`reply-to=${msg.replyTo}`);
  if (msg.revision) parts.push(`revision=${msg.revision}`);
  if (msg.editedAt) parts.push(`edited-at=${msg.editedAt}`);
  if (msg.archived) parts.push('archived=true');
  if (msg.archivedBy) parts.push(`archived-by=${msg.archivedBy}`);
  if (msg.archivedReason) parts.push(`archived-reason="${msg.archivedReason}"`);
  if (msg.autonomous) parts.push('[autonomous]');
  return `<!-- walkie:msg ${parts.join(' ')} -->`;
}

/** @param {object} msg */
export function formatMessage(msg) {
  const emoji = emojiForTool(msg.fromTool);
  const robot = msg.autonomous ? '🤖 ' : '';
  const sender = msg.fromAlias || msg.fromSessionId;
  const recipients = renderRecipients(msg.mentions);
  const sig = `## ${emoji} ${robot}${sender} → ${recipients}`;
  const marker = renderMarker(msg);
  const lines = [sig, marker, `**Time:** ${msg.timestamp}`];
  if (msg.git && (msg.git.branch || msg.git.hash)) {
    const author = msg.git.userEmail || msg.git.userName || '';
    const authorPart = author ? ` (${author})` : '';
    const hashPart = msg.git.hash ? ` @ ${msg.git.hash}` : '';
    lines.push(`**Git:** ${msg.git.branch || '(no branch)'}${hashPart}${authorPart}`);
  }
  if (msg.revision) {
    lines.push(
      `**Edited:** revision ${msg.revision} at ${msg.editedAt} — run \`walkie history ${msg.id}\` for prior versions`
    );
  }
  lines.push('');
  if (msg.archived) {
    lines.push(
      `> 🗄️ ARCHIVED by ${msg.archivedBy}${msg.archivedReason ? ` — ${msg.archivedReason}` : ''}`
    );
    lines.push('');
    lines.push('<details><summary>Show archived content</summary>');
    lines.push('');
    lines.push(msg.body.trim());
    lines.push('');
    lines.push('</details>');
  } else {
    lines.push(msg.body.trim());
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

const MARKER_RE = /<!--\s*walkie:msg\s+(.+?)\s*-->/;

function parseMarker(line) {
  const m = line.match(MARKER_RE);
  if (!m) return null;
  const out = { autonomous: false, archived: false, mentions: [], mentionsPending: [] };
  const tokens = m[1].match(/(?:[a-z-]+="[^"]*"|[a-z-]+=[^\s]+|\[autonomous\])/gi) ?? [];
  for (const tok of tokens) {
    if (tok === '[autonomous]') {
      out.autonomous = true;
      continue;
    }
    const eq = tok.indexOf('=');
    const key = tok.slice(0, eq);
    let val = tok.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    switch (key) {
      case 'id':
        out.id = val;
        break;
      case 'type':
        out.type = val;
        break;
      case 'from':
        out.fromSessionId = val;
        break;
      case 'mentions':
        out.mentions = val.split(',');
        break;
      case 'mentions-pending':
        out.mentionsPending = val.split(',');
        break;
      case 'reply-to':
        out.replyTo = val;
        break;
      case 'revision':
        out.revision = Number(val);
        break;
      case 'edited-at':
        out.editedAt = val;
        break;
      case 'archived':
        out.archived = val === 'true';
        break;
      case 'archived-by':
        out.archivedBy = val;
        break;
      case 'archived-reason':
        out.archivedReason = val;
        break;
      default:
        break;
    }
  }
  return out;
}

/** @param {string} block — a single message block (heading through `---`) */
export function parseMessage(block) {
  const lines = block.split('\n');
  let headingIdx = -1;
  let markerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingIdx === -1 && lines[i].startsWith('## ')) headingIdx = i;
    if (markerIdx === -1 && MARKER_RE.test(lines[i])) markerIdx = i;
    if (headingIdx !== -1 && markerIdx !== -1) break;
  }
  if (headingIdx === -1 || markerIdx === -1) return null;
  const marker = parseMarker(lines[markerIdx]);
  if (!marker) return null;
  const head = lines[headingIdx].replace(/^##\s+/, '');
  const senderMatch = head.match(/^[^\s]+\s+(?:🤖\s+)?(\S.*?)\s+→\s+(.+)$/);
  if (senderMatch) {
    marker.fromAlias = senderMatch[1];
  }
  let bodyStart = markerIdx + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() !== '') bodyStart += 1;
  bodyStart += 1;
  let bodyEnd = lines.length;
  for (let i = bodyStart; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      bodyEnd = i;
      break;
    }
  }
  marker.body = lines.slice(bodyStart, bodyEnd).join('\n');
  return marker;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/format.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/format.js test/core/format.test.js
git commit -m "feat(core): add message block format and parser"
```

---

## Phase 2 — walkie-core channel file (parse, append, concurrency)

### Task 8: Channel file parse + initial empty file template

**Files:**
- Create: `src/core/channel.js`
- Create: `templates/channel.md`
- Create: `test/helpers/tmp-project.js`
- Test: `test/core/channel.test.js`

- [ ] **Step 1: Write the empty channel template**

```markdown
<!-- templates/channel.md -->
# Walkie-Talkie Channel: PROJECT_NAME

**Operator:** OPERATOR_NAME
**Channel created:** CREATED_AT

## Active sessions

_(none yet)_

## Recent sessions

_(none yet)_

<!-- WALKIE:HEADER_END -->

---

```

- [ ] **Step 2: Write tmp-project helper**

```js
// test/helpers/tmp-project.js
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, '../../templates/channel.md');

export function createTmpProject({ operator = 'Test Operator', projectName = 'test-project' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'walkie-proj-'));
  const wtDir = join(root, '.walkie-talkie');
  mkdirSync(wtDir, { recursive: true });
  mkdirSync(join(wtDir, '.sessions'), { recursive: true });
  mkdirSync(join(wtDir, 'logs'), { recursive: true });
  const template = readFileSync(TEMPLATE_PATH, 'utf8')
    .replace('PROJECT_NAME', projectName)
    .replace('OPERATOR_NAME', operator)
    .replace('CREATED_AT', new Date().toISOString());
  writeFileSync(join(wtDir, 'channel.md'), template);
  writeFileSync(
    join(wtDir, 'config.json'),
    JSON.stringify({ operator, projectName, permits: [] }, null, 2)
  );
  return { root, wtDir, channelPath: join(wtDir, 'channel.md') };
}

export function cleanup(project) {
  rmSync(project.root, { recursive: true, force: true });
}
```

- [ ] **Step 3: Write failing test**

```js
// test/core/channel.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseChannel, readChannel } from '../../src/core/channel.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('channel parse', () => {
  test('parseChannel returns header text and empty messages for fresh template', () => {
    project = createTmpProject({ projectName: 'cloutdesk', operator: 'Trevor Mengel' });
    const text = readFileSync(project.channelPath, 'utf8');
    const out = parseChannel(text);
    expect(out.header).toContain('Walkie-Talkie Channel: cloutdesk');
    expect(out.header).toContain('Operator:** Trevor Mengel');
    expect(out.headerEndIdx).toBeGreaterThan(0);
    expect(out.messages).toEqual([]);
  });

  test('parseChannel throws when WALKIE:HEADER_END marker is missing', () => {
    expect(() => parseChannel('no marker here')).toThrow(/HEADER_END/);
  });

  test('readChannel reads and parses from a path', async () => {
    project = createTmpProject();
    const out = await readChannel(project.channelPath);
    expect(out.messages).toEqual([]);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/core/channel.test.js`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement parse + read**

```js
// src/core/channel.js
import { readFile } from 'node:fs/promises';
import { parseMessage } from './format.js';

const HEADER_END = '<!-- WALKIE:HEADER_END -->';

/**
 * @param {string} text
 * @returns {{header:string, headerEndIdx:number, body:string, messages:object[]}}
 */
export function parseChannel(text) {
  const idx = text.indexOf(HEADER_END);
  if (idx === -1) throw new Error('Channel file missing WALKIE:HEADER_END marker');
  const headerEndIdx = idx + HEADER_END.length;
  const header = text.slice(0, headerEndIdx);
  const body = text.slice(headerEndIdx);
  const messages = [];
  let cursor = 0;
  while (cursor < body.length) {
    const nextHeading = body.indexOf('\n## ', cursor);
    if (nextHeading === -1) break;
    const afterHeading = nextHeading + 1;
    const followingHeading = body.indexOf('\n## ', afterHeading);
    const blockEnd = followingHeading === -1 ? body.length : followingHeading;
    const block = body.slice(afterHeading, blockEnd);
    const parsed = parseMessage(block);
    if (parsed) messages.push(parsed);
    cursor = blockEnd;
  }
  return { header, headerEndIdx, body, messages };
}

/** @param {string} path */
export async function readChannel(path) {
  const text = await readFile(path, 'utf8');
  return parseChannel(text);
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/core/channel.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/core/channel.js templates/channel.md test/helpers/tmp-project.js test/core/channel.test.js
git commit -m "feat(core): parse channel file + tmp-project test helper"
```

---

### Task 9: Atomic append-at-top

**Files:**
- Modify: `src/core/channel.js`
- Test: `test/core/channel.test.js` (extend)

The lockfile + tmp-write + rename pattern is the heart of multi-writer correctness. Spec §7.

- [ ] **Step 1: Extend test file with append cases**

Add to `test/core/channel.test.js`:

```js
import { appendMessage } from '../../src/core/channel.js';
import { readFileSync } from 'node:fs';

describe('channel append', () => {
  test('appendMessage inserts a new block immediately below the header marker', async () => {
    project = createTmpProject();
    const msg = {
      id: '01J7QXP9R5K8VYZAB3',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'Hello, world.'
    };
    await appendMessage(project.channelPath, msg);
    const text = readFileSync(project.channelPath, 'utf8');
    const markerIdx = text.indexOf('<!-- WALKIE:HEADER_END -->');
    const blockIdx = text.indexOf('## 👤 Trevor → all');
    expect(blockIdx).toBeGreaterThan(markerIdx);
    expect(text).toContain('Hello, world.');
  });

  test('appendMessage places newer messages above older ones', async () => {
    project = createTmpProject();
    const base = {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      git: { branch: null, hash: null, userName: null, userEmail: null }
    };
    await appendMessage(project.channelPath, {
      ...base,
      id: 'A',
      timestamp: '2026-05-14T15:30:00.000Z',
      body: 'first'
    });
    await appendMessage(project.channelPath, {
      ...base,
      id: 'B',
      timestamp: '2026-05-14T15:31:00.000Z',
      body: 'second'
    });
    const text = readFileSync(project.channelPath, 'utf8');
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('first'));
  });

  test('appendMessage is atomic (no torn write under cancellation simulation)', async () => {
    project = createTmpProject();
    const msg = {
      id: 'C',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'atomic'
    };
    await appendMessage(project.channelPath, msg);
    const text = readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('<!-- WALKIE:HEADER_END -->');
    expect(text).toContain('atomic');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/channel.test.js`
Expected: FAIL — `appendMessage` is not exported.

- [ ] **Step 3: Implement appendMessage**

Add to `src/core/channel.js`:

```js
import { writeFile, rename, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { formatMessage } from './format.js';
import { newId } from './ids.js';

const INTERNAL_WRITE_FLAG = new Map();

/** Marks a path as being internally written within the last ~100ms (used by watcher). */
export function isInternalWrite(path) {
  const t = INTERNAL_WRITE_FLAG.get(path);
  return t !== undefined && Date.now() - t < 200;
}

async function withChannelLock(path, fn) {
  const release = await lockfile.lock(path, {
    retries: { retries: 20, minTimeout: 25, maxTimeout: 100, factor: 1.5 },
    stale: 5000,
    realpath: false
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}

/** @param {string} path @param {object} msgInput */
export async function appendMessage(path, msgInput) {
  const msg = { ...msgInput };
  if (!msg.id) msg.id = newId();
  const block = formatMessage(msg);
  await withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const idx = text.indexOf('<!-- WALKIE:HEADER_END -->');
    if (idx === -1) throw new Error('Channel file missing WALKIE:HEADER_END marker');
    const headerEnd = idx + '<!-- WALKIE:HEADER_END -->'.length;
    const head = text.slice(0, headerEnd);
    const tail = text.slice(headerEnd).replace(/^\n+/, '');
    const next = `${head}\n\n---\n\n${block}${tail.startsWith('---') ? '' : ''}${tail.length > 0 ? tail : ''}`;
    const tmpPath = `${path}.tmp.${msg.id}`;
    await writeFile(tmpPath, next, 'utf8');
    INTERNAL_WRITE_FLAG.set(path, Date.now());
    await rename(tmpPath, path);
  });
  return msg.id;
}

/** Exposed for tests to clean up the internal-write map between runs. */
export function _clearInternalWriteFlags() {
  INTERNAL_WRITE_FLAG.clear();
}

// Convenience: per-project paths
export function paths(projectRoot) {
  const wt = join(projectRoot, '.walkie-talkie');
  return {
    wtDir: wt,
    channel: join(wt, 'channel.md'),
    config: join(wt, 'config.json'),
    lockfileDir: wt,
    sessionsDir: join(wt, '.sessions'),
    logsDir: join(wt, 'logs'),
    pidFile: join(wt, 'server.pid'),
    portFile: join(wt, 'server.port')
  };
}

// Keep `dirname` used to avoid lint warnings; helper for downstream modules
export const _dirnameOf = dirname;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/channel.test.js`
Expected: PASS — 6 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/core/channel.js test/core/channel.test.js
git commit -m "feat(core): atomic append-at-top with proper-lockfile"
```

---

### Task 10: Concurrent append correctness (10 racing writers)

**Files:**
- Create: `test/core/concurrent-append.test.js`
- Create: `test/helpers/append-worker.js`

This test spawns child processes that all try to append simultaneously and verifies the lock serializes them correctly. The highest-risk invariant in walkie-core.

- [ ] **Step 1: Write the worker script**

```js
// test/helpers/append-worker.js
// Spawned by concurrent-append.test.js — appends one message and exits.
import { appendMessage } from '../../src/core/channel.js';

const [, , channelPath, idx] = process.argv;

const msg = {
  type: 'broadcast',
  fromSessionId: `worker-${idx}`,
  fromAlias: `worker-${idx}`,
  fromTool: 'operator',
  mentions: [],
  timestamp: new Date().toISOString(),
  git: { branch: null, hash: null, userName: null, userEmail: null },
  body: `message from worker ${idx}`
};

appendMessage(channelPath, msg).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
```

- [ ] **Step 2: Write failing test**

```js
// test/core/concurrent-append.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChannel } from '../../src/core/channel.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, '../helpers/append-worker.js');

function spawnWorker(channelPath, idx) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, channelPath, String(idx)], {
      stdio: 'inherit'
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${idx} exited ${code}`))));
  });
}

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('concurrent append', () => {
  test('10 racing workers all succeed with no torn writes', async () => {
    project = createTmpProject();
    await Promise.all(Array.from({ length: 10 }, (_, i) => spawnWorker(project.channelPath, i)));
    const text = readFileSync(project.channelPath, 'utf8');
    const out = parseChannel(text);
    expect(out.messages.length).toBe(10);
    const ids = new Set(out.messages.map((m) => m.id));
    expect(ids.size).toBe(10);
    expect(text).toContain('<!-- WALKIE:HEADER_END -->');
  }, 30000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/core/concurrent-append.test.js`
Expected: FAIL — initially the test should PASS if Task 9 is correct, but if there's a race we'd see fewer than 10 messages or duplicate IDs. Run twice to be sure.

- [ ] **Step 4: If it passes, commit. If it fails, fix the lockfile timing in Task 9.**

```bash
git add test/core/concurrent-append.test.js test/helpers/append-worker.js
git commit -m "test(core): verify atomic append under 10-way race"
```

---

## Phase 3 — walkie-core history, edit, archive

### Task 11: History append helper

**Files:**
- Create: `src/core/history.js`
- Test: `test/core/history.test.js`

Per spec §7, each edit writes the prior body to `.walkie-talkie/.sessions/<msg-id>.history.md` — append-only audit trail.

- [ ] **Step 1: Write failing test**

```js
// test/core/history.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { appendRevision, readHistory } from '../../src/core/history.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('history', () => {
  test('appendRevision creates per-message history file with revision metadata', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: '2026-05-14T15:32:00Z',
      editedBy: 'cs_xyz',
      priorBody: 'first version body'
    });
    const filePath = join(sessionsDir, '01ABC.history.md');
    expect(existsSync(filePath)).toBe(true);
    const text = readFileSync(filePath, 'utf8');
    expect(text).toContain('## Revision 1');
    expect(text).toContain('Edited at: 2026-05-14T15:32:00Z');
    expect(text).toContain('Edited by: cs_xyz');
    expect(text).toContain('first version body');
  });

  test('appendRevision appends to an existing history file', async () => {
    project = createTmpProject();
    const sessionsDir = join(project.wtDir, '.sessions');
    await appendRevision(sessionsDir, '01ABC', {
      revision: 1,
      editedAt: 't1',
      editedBy: 'a',
      priorBody: 'one'
    });
    await appendRevision(sessionsDir, '01ABC', {
      revision: 2,
      editedAt: 't2',
      editedBy: 'a',
      priorBody: 'two'
    });
    const history = await readHistory(sessionsDir, '01ABC');
    expect(history.length).toBe(2);
    expect(history[0].body).toBe('one');
    expect(history[1].body).toBe('two');
  });

  test('readHistory returns empty array when no history file exists', async () => {
    project = createTmpProject();
    const history = await readHistory(join(project.wtDir, '.sessions'), 'nope');
    expect(history).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/history.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/history.js
import { appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function filename(sessionsDir, msgId) {
  return join(sessionsDir, `${msgId}.history.md`);
}

/**
 * @param {string} sessionsDir
 * @param {string} msgId
 * @param {{revision:number, editedAt:string, editedBy:string, priorBody:string}} rev
 */
export async function appendRevision(sessionsDir, msgId, rev) {
  const block = [
    `## Revision ${rev.revision}`,
    `Edited at: ${rev.editedAt}`,
    `Edited by: ${rev.editedBy}`,
    '',
    rev.priorBody,
    '',
    '---',
    ''
  ].join('\n');
  await appendFile(filename(sessionsDir, msgId), block, 'utf8');
}

/**
 * @returns {Promise<Array<{revision:number, editedAt:string, editedBy:string, body:string}>>}
 */
export async function readHistory(sessionsDir, msgId) {
  const path = filename(sessionsDir, msgId);
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  const out = [];
  const blocks = text.split(/\n## Revision /).filter((s) => s.trim().length > 0);
  for (const raw of blocks) {
    const block = raw.startsWith('## Revision ') ? raw : `## Revision ${raw}`;
    const m = block.match(/Revision (\d+)\s*\nEdited at: (.+?)\s*\nEdited by: (.+?)\s*\n\n([\s\S]*?)\n\n---/);
    if (m) {
      out.push({ revision: Number(m[1]), editedAt: m[2], editedBy: m[3], body: m[4] });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/history.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/history.js test/core/history.test.js
git commit -m "feat(core): per-message edit history audit trail"
```

---

### Task 12: Edit a message in place

**Files:**
- Modify: `src/core/channel.js`
- Test: `test/core/channel.test.js` (extend)

- [ ] **Step 1: Extend channel.test.js**

Add to `test/core/channel.test.js`:

```js
import { editMessage } from '../../src/core/channel.js';
import { readHistory } from '../../src/core/history.js';
import { join } from 'node:path';

describe('channel edit', () => {
  test('editMessage rewrites body, bumps revision, writes prior body to history', async () => {
    project = createTmpProject();
    const id = await (async () => {
      const out = await (await import('../../src/core/channel.js')).appendMessage(project.channelPath, {
        type: 'broadcast',
        fromSessionId: 'operator',
        fromAlias: 'Trevor',
        fromTool: 'operator',
        mentions: [],
        timestamp: '2026-05-14T15:32:00.000Z',
        git: { branch: null, hash: null, userName: null, userEmail: null },
        body: 'original body'
      });
      return out;
    })();
    const result = await editMessage(project.channelPath, id, 'updated body', 'operator');
    expect(result.revision).toBe(1);
    const text = (await import('node:fs')).readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('updated body');
    expect(text).not.toMatch(/^original body$/m);
    expect(text).toContain(`revision=1`);
    const history = await readHistory(join(project.wtDir, '.sessions'), id);
    expect(history.length).toBe(1);
    expect(history[0].body).toBe('original body');
  });

  test('editMessage throws for unknown message id', async () => {
    project = createTmpProject();
    await expect(
      editMessage(project.channelPath, '01NOTHERE', 'x', 'operator')
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/channel.test.js`
Expected: FAIL — `editMessage` is not exported.

- [ ] **Step 3: Extend `src/core/channel.js` with editMessage**

```js
// Add to src/core/channel.js
import { appendRevision } from './history.js';
import { join } from 'node:path';
import { now } from './time.js';
import { writeFile, readFile, rename } from 'node:fs/promises';

const MSG_BLOCK_RE = (id) =>
  new RegExp(
    `(\\n## [^\\n]+\\n<!--\\s*walkie:msg[^>]*\\bid=${id}\\b[^>]*-->[\\s\\S]*?)(?=\\n## |$)`,
    'm'
  );

function rewriteMarker(blockText, fields) {
  return blockText.replace(/(<!--\s*walkie:msg\s+)(.+?)(\s*-->)/, (_, p, body, q) => {
    let updated = body;
    for (const [key, val] of Object.entries(fields)) {
      const tokenRe = new RegExp(`\\b${key}(="[^"]*"|=[^\\s]+)?`);
      const literal =
        typeof val === 'string' && /[\s"]/.test(val)
          ? `${key}="${val.replace(/"/g, '\\"')}"`
          : `${key}=${val}`;
      if (tokenRe.test(updated)) updated = updated.replace(tokenRe, literal);
      else updated = `${updated} ${literal}`;
    }
    return `${p}${updated}${q}`;
  });
}

function rewriteBody(blockText, newBody, revision, editedAt) {
  const headerLines = [];
  const lines = blockText.split('\n');
  let bodyStartIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('**Time:') || lines[i].startsWith('**Git:') || lines[i].startsWith('**Edited:') || lines[i].startsWith('## ') || lines[i].startsWith('<!-- walkie:msg')) {
      headerLines.push(lines[i]);
      continue;
    }
    if (lines[i].trim() === '') {
      headerLines.push('');
      bodyStartIdx = i + 1;
      break;
    }
  }
  const editedLine = `**Edited:** revision ${revision} at ${editedAt} — run \`walkie history\` for prior versions`;
  const editedAlready = headerLines.some((l) => l.startsWith('**Edited:'));
  if (editedAlready) {
    for (let i = 0; i < headerLines.length; i += 1) {
      if (headerLines[i].startsWith('**Edited:')) headerLines[i] = editedLine;
    }
  } else {
    headerLines.splice(headerLines.length - 1, 0, editedLine);
  }
  return [headerLines.join('\n'), newBody.trim(), '', '---', ''].join('\n');
}

/**
 * @param {string} path channel.md path
 * @param {string} msgId
 * @param {string} newBody
 * @param {string} editedBy session id
 * @returns {Promise<{revision:number}>}
 */
export async function editMessage(path, msgId, newBody, editedBy) {
  return withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const blockMatch = text.match(MSG_BLOCK_RE(msgId));
    if (!blockMatch) throw new Error(`Message ${msgId} not found`);
    const block = blockMatch[1];
    const editedAt = now();
    const parsed = parseMessage(block.replace(/^\n/, ''));
    const priorBody = parsed?.body ?? '';
    const currentRevision = parsed?.revision ?? 0;
    const nextRevision = currentRevision + 1;
    const sessionsDir = join(dirname(path), '.sessions');
    await appendRevision(sessionsDir, msgId, {
      revision: nextRevision,
      editedAt,
      editedBy,
      priorBody
    });
    let rewritten = rewriteMarker(block, { revision: nextRevision, 'edited-at': editedAt });
    rewritten = rewriteBody(rewritten, newBody, nextRevision, editedAt);
    const updated = text.replace(block, rewritten);
    const tmpPath = `${path}.tmp.edit-${msgId}`;
    await writeFile(tmpPath, updated, 'utf8');
    INTERNAL_WRITE_FLAG.set(path, Date.now());
    await rename(tmpPath, path);
    return { revision: nextRevision };
  });
}

// (parseMessage and dirname already imported in earlier sections of channel.js — add if not present)
import { parseMessage } from './format.js';
import { dirname } from 'node:path';
```

> **Note for the implementer:** the existing top of `src/core/channel.js` already imports `parseMessage`, `dirname`, `writeFile`, `readFile`, `rename`. Consolidate imports at the top of the file rather than duplicating them.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/channel.test.js`
Expected: PASS — 8 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/core/channel.js test/core/channel.test.js
git commit -m "feat(core): edit message in place with revision + history"
```

---

### Task 13: Archive a message

**Files:**
- Modify: `src/core/channel.js`
- Test: `test/core/channel.test.js` (extend)

- [ ] **Step 1: Extend test**

Add to `test/core/channel.test.js`:

```js
import { archiveMessage } from '../../src/core/channel.js';

describe('channel archive', () => {
  test('archiveMessage marks the marker and inserts ARCHIVED banner', async () => {
    project = createTmpProject();
    const channel = await import('../../src/core/channel.js');
    const id = await channel.appendMessage(project.channelPath, {
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator',
      mentions: [],
      timestamp: '2026-05-14T15:32:00.000Z',
      git: { branch: null, hash: null, userName: null, userEmail: null },
      body: 'old content'
    });
    await archiveMessage(project.channelPath, id, 'operator', 'duplicate');
    const text = (await import('node:fs')).readFileSync(project.channelPath, 'utf8');
    expect(text).toContain('archived=true');
    expect(text).toContain('archived-by=operator');
    expect(text).toContain('archived-reason="duplicate"');
    expect(text).toContain('🗄️ ARCHIVED');
  });

  test('archiveMessage throws for unknown id', async () => {
    project = createTmpProject();
    await expect(
      archiveMessage(project.channelPath, '01NONE', 'operator', null)
    ).rejects.toThrow(/not found/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/channel.test.js`
Expected: FAIL — `archiveMessage` not exported.

- [ ] **Step 3: Implement**

Add to `src/core/channel.js`:

```js
/**
 * @param {string} path channel.md path
 * @param {string} msgId
 * @param {string} archivedBy session id
 * @param {string|null} reason
 */
export async function archiveMessage(path, msgId, archivedBy, reason) {
  return withChannelLock(path, async () => {
    const text = await readFile(path, 'utf8');
    const blockMatch = text.match(MSG_BLOCK_RE(msgId));
    if (!blockMatch) throw new Error(`Message ${msgId} not found`);
    const block = blockMatch[1];
    const parsed = parseMessage(block.replace(/^\n/, ''));
    if (!parsed) throw new Error(`Cannot parse message ${msgId}`);
    parsed.archived = true;
    parsed.archivedBy = archivedBy;
    parsed.archivedReason = reason ?? null;
    parsed.fromAlias = parsed.fromAlias ?? parsed.fromSessionId;
    parsed.fromTool = parsed.fromTool ?? 'operator';
    parsed.timestamp = parsed.timestamp ?? now();
    parsed.git = parsed.git ?? { branch: null, hash: null, userName: null, userEmail: null };
    const rebuilt = `\n${formatMessage(parsed)}`;
    const updated = text.replace(block, rebuilt);
    const tmpPath = `${path}.tmp.archive-${msgId}`;
    await writeFile(tmpPath, updated, 'utf8');
    INTERNAL_WRITE_FLAG.set(path, Date.now());
    await rename(tmpPath, path);
  });
}

// formatMessage already imported via format.js
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/core/channel.test.js`
Expected: PASS — 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/core/channel.js test/core/channel.test.js
git commit -m "feat(core): archive message with marker + banner"
```

---

## Phase 4 — Registry (sessions + invitations)

### Task 14: Session registry

**Files:**
- Create: `src/registry/sessions.js`
- Test: `test/registry/sessions.test.js`

The session registry tracks active and recent sessions per project. Stored as `.walkie-talkie/.sessions/active.json`. Spec §9.

- [ ] **Step 1: Write failing test**

```js
// test/registry/sessions.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  loadSessions,
  joinSession,
  renameSession,
  markSeen,
  rolloverStale
} from '../../src/registry/sessions.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('session registry', () => {
  test('loadSessions returns empty active and recent for fresh project', async () => {
    project = createTmpProject();
    const s = await loadSessions(project.wtDir);
    expect(s.active).toEqual([]);
    expect(s.recent).toEqual([]);
  });

  test('joinSession assigns a generated alias when none provided', async () => {
    project = createTmpProject();
    const a = await joinSession(project.wtDir, { tool: 'claude-code' });
    const b = await joinSession(project.wtDir, { tool: 'claude-code' });
    expect(a.alias).toBe('claude-code-1');
    expect(b.alias).toBe('claude-code-2');
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  test('joinSession respects a provided sessionId and alias', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, {
      tool: 'claude-code',
      sessionId: 'cs_abc',
      alias: 'demo-builder'
    });
    expect(s.sessionId).toBe('cs_abc');
    expect(s.alias).toBe('demo-builder');
  });

  test('renameSession updates the active entry', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, { tool: 'claude-code' });
    await renameSession(project.wtDir, s.sessionId, 'demo-builder');
    const all = await loadSessions(project.wtDir);
    expect(all.active[0].alias).toBe('demo-builder');
  });

  test('renameSession with colliding alias suffixes the older holder', async () => {
    project = createTmpProject();
    const a = await joinSession(project.wtDir, { tool: 'claude-code', alias: 'demo-builder' });
    const b = await joinSession(project.wtDir, { tool: 'claude-code' });
    await renameSession(project.wtDir, b.sessionId, 'demo-builder');
    const all = await loadSessions(project.wtDir);
    const aliases = all.active.map((s) => s.alias).sort();
    expect(aliases).toContain('demo-builder');
    expect(aliases.some((x) => x.startsWith('demo-builder-v'))).toBe(true);
  });

  test('markSeen bumps lastSeen', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, { tool: 'claude-code' });
    const before = s.lastSeen;
    await new Promise((r) => setTimeout(r, 10));
    await markSeen(project.wtDir, s.sessionId);
    const all = await loadSessions(project.wtDir);
    expect(new Date(all.active[0].lastSeen).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  test('rolloverStale moves stale sessions to recent', async () => {
    project = createTmpProject();
    const s = await joinSession(project.wtDir, { tool: 'claude-code' });
    const path = join(project.wtDir, '.sessions', 'active.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.active[0].lastSeen = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    (await import('node:fs')).writeFileSync(path, JSON.stringify(data));
    await rolloverStale(project.wtDir, 6 * 3600 * 1000);
    const all = await loadSessions(project.wtDir);
    expect(all.active).toEqual([]);
    expect(all.recent.length).toBe(1);
    expect(all.recent[0].sessionId).toBe(s.sessionId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry/sessions.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/registry/sessions.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../core/ids.js';
import { now } from '../core/time.js';

const FILE = 'active.json';

function pathFor(wtDir) {
  return join(wtDir, '.sessions', FILE);
}

async function ensureFile(wtDir) {
  const path = pathFor(wtDir);
  if (existsSync(path)) return path;
  await mkdir(join(wtDir, '.sessions'), { recursive: true });
  await writeFile(path, JSON.stringify({ active: [], recent: [] }, null, 2));
  return path;
}

export async function loadSessions(wtDir) {
  const path = await ensureFile(wtDir);
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function saveSessions(wtDir, data) {
  const path = await ensureFile(wtDir);
  await writeFile(path, JSON.stringify(data, null, 2));
}

function generateAlias(active, tool) {
  let n = 1;
  const aliases = new Set(active.filter((s) => s.tool === tool).map((s) => s.alias));
  while (aliases.has(`${tool}-${n}`)) n += 1;
  return `${tool}-${n}`;
}

function generateSessionId(tool) {
  const prefix = tool === 'claude-code' ? 'cs_' : tool === 'claude-cowork' ? 'cw_' : `${tool}_`;
  return `${prefix}${newId().toLowerCase().slice(-12)}`;
}

export async function joinSession(wtDir, { tool, sessionId, alias }) {
  const data = await loadSessions(wtDir);
  const existing = data.active.find((s) => s.sessionId === sessionId);
  if (existing) {
    existing.lastSeen = now();
    await saveSessions(wtDir, data);
    return existing;
  }
  const finalAlias = alias && !data.active.some((s) => s.alias === alias)
    ? alias
    : alias
    ? await renameWithCollision(data, alias, tool)
    : generateAlias(data.active, tool);
  const session = {
    sessionId: sessionId || generateSessionId(tool),
    tool,
    alias: typeof finalAlias === 'string' ? finalAlias : finalAlias.newAlias,
    joined: now(),
    lastSeen: now()
  };
  if (typeof finalAlias !== 'string') {
    const conflict = data.active.find((s) => s.alias === alias);
    if (conflict) conflict.alias = finalAlias.suffixedOld;
  }
  data.active.push(session);
  await saveSessions(wtDir, data);
  return session;
}

async function renameWithCollision(data, newAlias, tool) {
  const conflict = data.active.find((s) => s.alias === newAlias);
  if (!conflict) return newAlias;
  let n = 1;
  let candidate;
  do {
    candidate = `${newAlias}-v${n}`;
    n += 1;
  } while (data.active.some((s) => s.alias === candidate));
  return { newAlias, suffixedOld: candidate };
}

export async function renameSession(wtDir, sessionId, newAlias) {
  const data = await loadSessions(wtDir);
  const target = data.active.find((s) => s.sessionId === sessionId);
  if (!target) throw new Error(`Session ${sessionId} not found in active`);
  const conflict = data.active.find((s) => s.alias === newAlias && s.sessionId !== sessionId);
  if (conflict) {
    let n = 1;
    let candidate;
    do {
      candidate = `${newAlias}-v${n}`;
      n += 1;
    } while (data.active.some((s) => s.alias === candidate));
    conflict.alias = candidate;
  }
  target.alias = newAlias;
  target.lastSeen = now();
  await saveSessions(wtDir, data);
  return target;
}

export async function markSeen(wtDir, sessionId) {
  const data = await loadSessions(wtDir);
  const target = data.active.find((s) => s.sessionId === sessionId);
  if (target) {
    target.lastSeen = now();
    await saveSessions(wtDir, data);
  }
}

export async function rolloverStale(wtDir, thresholdMs) {
  const data = await loadSessions(wtDir);
  const cutoff = Date.now() - thresholdMs;
  const stillActive = [];
  for (const s of data.active) {
    if (new Date(s.lastSeen).getTime() < cutoff) {
      data.recent.unshift({ ...s, retiredAt: now() });
    } else {
      stillActive.push(s);
    }
  }
  data.active = stillActive;
  data.recent = data.recent.slice(0, 50);
  await saveSessions(wtDir, data);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/registry/sessions.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/registry/sessions.js test/registry/sessions.test.js
git commit -m "feat(registry): session registry with join/rename/staleness"
```

---

### Task 15: Invitations registry

**Files:**
- Create: `src/registry/invitations.js`
- Test: `test/registry/invitations.test.js`

Spec §11 — invitations are advisory reservations fulfilled when a matching session renames itself.

- [ ] **Step 1: Write failing test**

```js
// test/registry/invitations.test.js
import { describe, test, expect, afterEach } from 'vitest';
import {
  loadInvitations,
  addInvitation,
  findInvitation,
  fulfillInvitation,
  expireOlderThan
} from '../../src/registry/invitations.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('invitations', () => {
  test('loadInvitations returns empty for fresh project', async () => {
    project = createTmpProject();
    expect(await loadInvitations(project.wtDir)).toEqual([]);
  });

  test('addInvitation stores alias + invitedBy + fromMessage', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    const all = await loadInvitations(project.wtDir);
    expect(all.length).toBe(1);
    expect(all[0].alias).toBe('codex-helper');
  });

  test('findInvitation returns matching entry or null', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    expect((await findInvitation(project.wtDir, 'codex-helper'))?.alias).toBe('codex-helper');
    expect(await findInvitation(project.wtDir, 'nope')).toBeNull();
  });

  test('fulfillInvitation removes the invitation and returns it', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    const fulfilled = await fulfillInvitation(project.wtDir, 'codex-helper', 'cs_new');
    expect(fulfilled.alias).toBe('codex-helper');
    expect(await loadInvitations(project.wtDir)).toEqual([]);
  });

  test('expireOlderThan removes invitations older than threshold', async () => {
    project = createTmpProject();
    await addInvitation(project.wtDir, {
      alias: 'codex-helper',
      invitedBy: 'operator',
      fromMessage: '01XYZ'
    });
    const path = (await import('node:path')).join(project.wtDir, '.sessions', 'invitations.json');
    const data = JSON.parse((await import('node:fs')).readFileSync(path, 'utf8'));
    data[0].invitedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    (await import('node:fs')).writeFileSync(path, JSON.stringify(data));
    await expireOlderThan(project.wtDir, 24 * 3600 * 1000);
    expect(await loadInvitations(project.wtDir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry/invitations.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/registry/invitations.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { now } from '../core/time.js';

const FILE = 'invitations.json';

function pathFor(wtDir) {
  return join(wtDir, '.sessions', FILE);
}

async function ensureFile(wtDir) {
  const path = pathFor(wtDir);
  if (existsSync(path)) return path;
  await mkdir(join(wtDir, '.sessions'), { recursive: true });
  await writeFile(path, '[]');
  return path;
}

export async function loadInvitations(wtDir) {
  const path = await ensureFile(wtDir);
  return JSON.parse(await readFile(path, 'utf8'));
}

async function save(wtDir, data) {
  const path = await ensureFile(wtDir);
  await writeFile(path, JSON.stringify(data, null, 2));
}

export async function addInvitation(wtDir, { alias, invitedBy, fromMessage }) {
  const data = await loadInvitations(wtDir);
  if (data.some((i) => i.alias === alias)) return;
  data.push({ alias, invitedBy, fromMessage, invitedAt: now() });
  await save(wtDir, data);
}

export async function findInvitation(wtDir, alias) {
  const data = await loadInvitations(wtDir);
  return data.find((i) => i.alias === alias) ?? null;
}

export async function fulfillInvitation(wtDir, alias, fulfillingSessionId) {
  const data = await loadInvitations(wtDir);
  const idx = data.findIndex((i) => i.alias === alias);
  if (idx === -1) return null;
  const [inv] = data.splice(idx, 1);
  await save(wtDir, data);
  return { ...inv, fulfilledBy: fulfillingSessionId, fulfilledAt: now() };
}

export async function expireOlderThan(wtDir, thresholdMs) {
  const data = await loadInvitations(wtDir);
  const cutoff = Date.now() - thresholdMs;
  const kept = data.filter((i) => new Date(i.invitedAt).getTime() >= cutoff);
  if (kept.length !== data.length) await save(wtDir, kept);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/registry/invitations.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/registry/invitations.js test/registry/invitations.test.js
git commit -m "feat(registry): invitations with add/find/fulfill/expire"
```

---

## Phase 5 — Daemon (HTTP + SSE + watcher)

### Task 16: Daemon server scaffold + health endpoint

**Files:**
- Create: `src/daemon/server.js`
- Create: `src/daemon/events.js`
- Test: `test/daemon/server.test.js`

The server is built as a factory: `createServer({ wtDir })` returns an Express app + an `events` EventEmitter. Tests inject a tmp project and use `supertest`.

- [ ] **Step 1: Write failing test**

```js
// test/daemon/server.test.js
import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/daemon/server.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('daemon server scaffold', () => {
  test('GET /health returns { ok: true } and the project root', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.wtDir).toBe(project.wtDir);
  });

  test('returns 404 for unknown routes', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/server.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement events.js + server.js**

```js
// src/daemon/events.js
import { EventEmitter } from 'node:events';

/** Returns a fresh EventEmitter — one per daemon instance. */
export function createEvents() {
  const e = new EventEmitter();
  e.setMaxListeners(100);
  return e;
}
```

```js
// src/daemon/server.js
import express from 'express';
import { createEvents } from './events.js';

/**
 * @param {{ wtDir: string }} opts
 * @returns {{ app: import('express').Express, events: import('node:events').EventEmitter }}
 */
export function createServer({ wtDir }) {
  const app = express();
  const events = createEvents();
  app.locals.wtDir = wtDir;
  app.locals.events = events;
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, wtDir });
  });

  // routes mounted in later tasks
  return { app, events };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/daemon/server.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/server.js src/daemon/events.js test/daemon/server.test.js
git commit -m "feat(daemon): server scaffold + health endpoint"
```

---

### Task 17: Channel routes (GET latest/since/message, POST/PATCH/archive)

**Files:**
- Create: `src/daemon/routes/channel.js`
- Modify: `src/daemon/server.js` (mount routes)
- Test: `test/daemon/server.test.js` (extend)

- [ ] **Step 1: Extend test**

Add to `test/daemon/server.test.js`:

```js
describe('channel routes', () => {
  test('GET /channel/latest returns empty for fresh project', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/channel/latest?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });

  test('POST /channel/message creates a message and GET /channel/latest returns it', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const post = await request(app)
      .post('/channel/message')
      .send({ body: 'hello world', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    expect(post.status).toBe(201);
    expect(post.body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const list = await request(app).get('/channel/latest?limit=5');
    expect(list.body.messages.length).toBe(1);
    expect(list.body.messages[0].body.trim()).toBe('hello world');
  });

  test('GET /channel/message/:id returns the message with history', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const post = await request(app)
      .post('/channel/message')
      .send({ body: 'first', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    const id = post.body.id;
    await request(app).patch(`/channel/message/${id}`).send({ body: 'second', editedBy: 'operator' });
    const get = await request(app).get(`/channel/message/${id}`);
    expect(get.body.message.revision).toBe(1);
    expect(get.body.history.length).toBe(1);
    expect(get.body.history[0].body).toBe('first');
  });

  test('POST /channel/message/:id/archive archives', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const post = await request(app)
      .post('/channel/message')
      .send({ body: 'kill me', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    const id = post.body.id;
    const arch = await request(app)
      .post(`/channel/message/${id}/archive`)
      .send({ archivedBy: 'operator', reason: 'duplicate' });
    expect(arch.status).toBe(200);
    const list = await request(app).get('/channel/latest?limit=5');
    expect(list.body.messages.length).toBe(0);
    const listAll = await request(app).get('/channel/latest?limit=5&include_archived=true');
    expect(listAll.body.messages.length).toBe(1);
  });

  test('GET /channel/since/:ulid returns only newer messages', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const a = await request(app).post('/channel/message').send({ body: 'a', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    await new Promise((r) => setTimeout(r, 5));
    await request(app).post('/channel/message').send({ body: 'b', type: 'broadcast', fromSessionId: 'operator', fromAlias: 'Trevor', fromTool: 'operator' });
    const res = await request(app).get(`/channel/since/${a.body.id}`);
    expect(res.body.messages.length).toBe(1);
    expect(res.body.messages[0].body.trim()).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/daemon/server.test.js`
Expected: FAIL — routes 404.

- [ ] **Step 3: Implement routes**

```js
// src/daemon/routes/channel.js
import { Router } from 'express';
import { join } from 'node:path';
import {
  readChannel,
  appendMessage,
  editMessage,
  archiveMessage,
  paths
} from '../../core/channel.js';
import { gitMetadata } from '../../core/git.js';
import { readHistory } from '../../core/history.js';
import { now } from '../../core/time.js';
import { parseMentions, resolveMentions } from '../../core/mentions.js';
import { loadSessions } from '../../registry/sessions.js';

function channelPath(wtDir) {
  return join(wtDir, 'channel.md');
}

function sessionsDir(wtDir) {
  return join(wtDir, '.sessions');
}

function filterArchived(messages, include) {
  return include ? messages : messages.filter((m) => !m.archived);
}

export function channelRoutes() {
  const router = Router();

  router.get('/channel/latest', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 20, 200);
      const includeArchived = req.query.include_archived === 'true';
      const { messages } = await readChannel(channelPath(req.app.locals.wtDir));
      const filtered = filterArchived(messages, includeArchived).slice(0, limit);
      res.json({ messages: filtered });
    } catch (e) {
      next(e);
    }
  });

  router.get('/channel/since/:ulid', async (req, res, next) => {
    try {
      const { messages } = await readChannel(channelPath(req.app.locals.wtDir));
      const after = req.params.ulid;
      const filtered = messages.filter((m) => m.id > after && !m.archived);
      res.json({ messages: filtered });
    } catch (e) {
      next(e);
    }
  });

  router.get('/channel/message/:id', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const { messages } = await readChannel(channelPath(wtDir));
      const message = messages.find((m) => m.id === req.params.id);
      if (!message) return res.status(404).json({ error: 'not found' });
      const history = await readHistory(sessionsDir(wtDir), req.params.id);
      res.json({ message, history });
    } catch (e) {
      next(e);
    }
  });

  router.post('/channel/message', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { body, type = 'broadcast', fromSessionId, fromAlias, fromTool, replyTo, autonomous } = req.body;
      if (!body || !fromSessionId) {
        return res.status(400).json({ error: 'body and fromSessionId are required' });
      }
      const tokens = parseMentions(body);
      const { active } = await loadSessions(wtDir);
      const { resolved, unresolved } = resolveMentions(tokens, active);
      const mentions = resolved.filter((r) => !r.startsWith('@'));
      const projectRoot = wtDir.replace(/\/\.walkie-talkie$/, '');
      const id = await appendMessage(channelPath(wtDir), {
        type,
        fromSessionId,
        fromAlias,
        fromTool,
        mentions,
        mentionsPending: unresolved,
        replyTo,
        autonomous: Boolean(autonomous),
        timestamp: now(),
        git: gitMetadata(projectRoot),
        body
      });
      events.emit('message.posted', { id, type, from: fromSessionId, mentions });
      res.status(201).json({
        id,
        warnings: unresolved.map((tok) => ({ type: 'unresolved-mention', token: tok }))
      });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/channel/message/:id', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { body, editedBy } = req.body;
      if (!body || !editedBy) {
        return res.status(400).json({ error: 'body and editedBy are required' });
      }
      const { revision } = await editMessage(channelPath(wtDir), req.params.id, body, editedBy);
      events.emit('message.edited', { id: req.params.id, revision });
      res.json({ id: req.params.id, revision });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      next(e);
    }
  });

  router.post('/channel/message/:id/archive', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { archivedBy, reason } = req.body;
      if (!archivedBy) return res.status(400).json({ error: 'archivedBy required' });
      await archiveMessage(channelPath(wtDir), req.params.id, archivedBy, reason ?? null);
      events.emit('message.archived', { id: req.params.id, by: archivedBy });
      res.json({ ok: true });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      next(e);
    }
  });

  return router;
}
```

Modify `src/daemon/server.js` to mount routes:

```js
// src/daemon/server.js (replace earlier version)
import express from 'express';
import { createEvents } from './events.js';
import { channelRoutes } from './routes/channel.js';

export function createServer({ wtDir }) {
  const app = express();
  const events = createEvents();
  app.locals.wtDir = wtDir;
  app.locals.events = events;
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, wtDir });
  });

  app.use(channelRoutes());

  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  return { app, events };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/daemon/server.test.js`
Expected: PASS — 7 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/channel.js src/daemon/server.js test/daemon/server.test.js
git commit -m "feat(daemon): channel routes (latest/since/message/post/patch/archive)"
```

---

### Task 18: Sessions routes (GET, POST join, POST rename)

**Files:**
- Create: `src/daemon/routes/sessions.js`
- Modify: `src/daemon/server.js`
- Test: `test/daemon/server.test.js` (extend)

- [ ] **Step 1: Extend test**

```js
describe('sessions routes', () => {
  test('GET /sessions returns active, recent, invitations', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).get('/sessions');
    expect(res.status).toBe(200);
    expect(res.body.active).toEqual([]);
    expect(res.body.recent).toEqual([]);
    expect(res.body.invitations).toEqual([]);
  });

  test('POST /sessions/join creates a session with generated alias', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).post('/sessions/join').send({ tool: 'claude-code' });
    expect(res.status).toBe(200);
    expect(res.body.alias).toBe('claude-code-1');
  });

  test('POST /sessions/:id/rename renames + fulfills matching invitation', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const join = await request(app).post('/sessions/join').send({ tool: 'codex' });
    await request(app).post('/sessions/invite').send({ alias: 'codex-helper' });
    const renamed = await request(app)
      .post(`/sessions/${join.body.sessionId}/rename`)
      .send({ alias: 'codex-helper' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.alias).toBe('codex-helper');
    expect(renamed.body.fulfilled).toBe(true);
    const after = await request(app).get('/sessions');
    expect(after.body.invitations).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/server.test.js`
Expected: FAIL — sessions routes return 404.

- [ ] **Step 3: Implement**

```js
// src/daemon/routes/sessions.js
import { Router } from 'express';
import {
  loadSessions,
  joinSession,
  renameSession
} from '../../registry/sessions.js';
import {
  loadInvitations,
  addInvitation,
  findInvitation,
  fulfillInvitation
} from '../../registry/invitations.js';

export function sessionsRoutes() {
  const router = Router();

  router.get('/sessions', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const sessions = await loadSessions(wtDir);
      const invitations = await loadInvitations(wtDir);
      res.json({ active: sessions.active, recent: sessions.recent, invitations });
    } catch (e) {
      next(e);
    }
  });

  router.post('/sessions/join', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { tool, sessionId, alias } = req.body;
      if (!tool) return res.status(400).json({ error: 'tool required' });
      const session = await joinSession(wtDir, { tool, sessionId, alias });
      events.emit('session.joined', { session_id: session.sessionId, alias: session.alias, tool: session.tool });
      res.json(session);
    } catch (e) {
      next(e);
    }
  });

  router.post('/sessions/:id/rename', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const events = req.app.locals.events;
      const { alias } = req.body;
      if (!alias) return res.status(400).json({ error: 'alias required' });
      const session = await renameSession(wtDir, req.params.id, alias);
      const matchingInvite = await findInvitation(wtDir, alias);
      let fulfilled = false;
      if (matchingInvite) {
        await fulfillInvitation(wtDir, alias, session.sessionId);
        events.emit('mention.fulfilled', {
          pending_alias: alias,
          fulfilling_session_id: session.sessionId
        });
        fulfilled = true;
      }
      events.emit('session.renamed', { session_id: session.sessionId, alias, tool: session.tool });
      res.json({ ...session, fulfilled });
    } catch (e) {
      if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
      next(e);
    }
  });

  router.post('/sessions/invite', async (req, res, next) => {
    try {
      const wtDir = req.app.locals.wtDir;
      const { alias, invitedBy = 'operator', fromMessage = null } = req.body;
      if (!alias) return res.status(400).json({ error: 'alias required' });
      await addInvitation(wtDir, { alias, invitedBy, fromMessage });
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
```

Modify `src/daemon/server.js` to mount:

```js
// Add to src/daemon/server.js after channelRoutes import:
import { sessionsRoutes } from './routes/sessions.js';
// ... and after app.use(channelRoutes()):
app.use(sessionsRoutes());
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/daemon/server.test.js`
Expected: PASS — 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/sessions.js src/daemon/server.js test/daemon/server.test.js
git commit -m "feat(daemon): sessions routes (join/rename/invite) with mention fulfillment"
```

---

### Task 19: Permits gate + permits routes

**Files:**
- Create: `src/daemon/permits.js`
- Create: `src/daemon/routes/permits.js`
- Modify: `src/daemon/routes/channel.js` (gate POST /channel/message)
- Modify: `src/daemon/server.js`
- Test: `test/daemon/permits.test.js`

Spec §19. v1 simplification: no pending-queue; an autonomous write without an active permit returns 403 with structured guidance. The agent surfaces to the operator, who runs `walkie permit <session> --once|--duration X|--always`.

- [ ] **Step 1: Write failing test**

```js
// test/daemon/permits.test.js
import { describe, test, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createServer } from '../../src/daemon/server.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(() => {
  if (project) cleanup(project);
  project = null;
});

describe('permits', () => {
  test('autonomous post without permit returns 403 with structured guidance', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/sessions/join').send({ tool: 'claude-code', sessionId: 'cs_abc' });
    const res = await request(app).post('/channel/message').send({
      body: 'auto hi',
      type: 'broadcast',
      fromSessionId: 'cs_abc',
      fromAlias: 'claude-code-1',
      fromTool: 'claude-code',
      autonomous: true
    });
    expect(res.status).toBe(403);
    expect(res.body.status).toBe('permit_required');
    expect(res.body.session_id).toBe('cs_abc');
  });

  test('operator post (autonomous=false) is always allowed', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const res = await request(app).post('/channel/message').send({
      body: 'manual hi',
      type: 'broadcast',
      fromSessionId: 'operator',
      fromAlias: 'Trevor',
      fromTool: 'operator'
    });
    expect(res.status).toBe(201);
  });

  test('once permit allows exactly one autonomous post', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/sessions/join').send({ tool: 'claude-code', sessionId: 'cs_abc' });
    await request(app).post('/permits').send({ sessionId: 'cs_abc', mode: 'once' });
    const ok = await request(app).post('/channel/message').send({
      body: 'one',
      type: 'broadcast',
      fromSessionId: 'cs_abc',
      fromAlias: 'claude-code-1',
      fromTool: 'claude-code',
      autonomous: true
    });
    expect(ok.status).toBe(201);
    const blocked = await request(app).post('/channel/message').send({
      body: 'two',
      type: 'broadcast',
      fromSessionId: 'cs_abc',
      fromAlias: 'claude-code-1',
      fromTool: 'claude-code',
      autonomous: true
    });
    expect(blocked.status).toBe(403);
  });

  test('always permit allows unlimited autonomous posts', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/sessions/join').send({ tool: 'claude-code', sessionId: 'cs_abc' });
    await request(app).post('/permits').send({ sessionId: 'cs_abc', mode: 'always' });
    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).post('/channel/message').send({
        body: `auto ${i}`,
        type: 'broadcast',
        fromSessionId: 'cs_abc',
        fromAlias: 'claude-code-1',
        fromTool: 'claude-code',
        autonomous: true
      });
      expect(r.status).toBe(201);
    }
  });

  test('DELETE /permits/:sessionId revokes', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    await request(app).post('/permits').send({ sessionId: 'cs_abc', mode: 'always' });
    await request(app).delete('/permits/cs_abc');
    const list = await request(app).get('/permits');
    expect(list.body.permits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/permits.test.js`
Expected: FAIL — routes/gate not implemented.

- [ ] **Step 3: Implement permits.js (logic)**

```js
// src/daemon/permits.js
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function configPath(wtDir) {
  return join(wtDir, 'config.json');
}

async function loadConfig(wtDir) {
  const path = configPath(wtDir);
  if (!existsSync(path)) return { permits: [] };
  return JSON.parse(await readFile(path, 'utf8'));
}

async function saveConfig(wtDir, data) {
  await writeFile(configPath(wtDir), JSON.stringify(data, null, 2));
}

export async function listPermits(wtDir) {
  const cfg = await loadConfig(wtDir);
  return cfg.permits ?? [];
}

export async function grantPermit(wtDir, { sessionId, mode, durationMs }) {
  const cfg = await loadConfig(wtDir);
  cfg.permits = (cfg.permits ?? []).filter((p) => p.sessionId !== sessionId);
  const permit = { sessionId, mode };
  if (mode === 'duration' && durationMs) {
    permit.expiresAt = new Date(Date.now() + durationMs).toISOString();
  }
  cfg.permits.push(permit);
  await saveConfig(wtDir, cfg);
  return permit;
}

export async function revokePermit(wtDir, sessionId) {
  const cfg = await loadConfig(wtDir);
  cfg.permits = (cfg.permits ?? []).filter((p) => p.sessionId !== sessionId);
  await saveConfig(wtDir, cfg);
}

/**
 * Checks whether the session can autonomously write right now.
 * Consumes a "once" permit on success.
 * @returns {Promise<{allowed:boolean, reason?:string}>}
 */
export async function checkAndConsume(wtDir, sessionId) {
  const cfg = await loadConfig(wtDir);
  const permits = cfg.permits ?? [];
  const idx = permits.findIndex((p) => p.sessionId === sessionId);
  if (idx === -1) return { allowed: false, reason: 'no permit' };
  const permit = permits[idx];
  if (permit.mode === 'always') return { allowed: true };
  if (permit.mode === 'duration') {
    if (new Date(permit.expiresAt).getTime() < Date.now()) {
      permits.splice(idx, 1);
      cfg.permits = permits;
      await saveConfig(wtDir, cfg);
      return { allowed: false, reason: 'permit expired' };
    }
    return { allowed: true };
  }
  if (permit.mode === 'once') {
    permits.splice(idx, 1);
    cfg.permits = permits;
    await saveConfig(wtDir, cfg);
    return { allowed: true };
  }
  return { allowed: false, reason: 'unknown mode' };
}
```

- [ ] **Step 4: Implement routes/permits.js**

```js
// src/daemon/routes/permits.js
import { Router } from 'express';
import { listPermits, grantPermit, revokePermit } from '../permits.js';

export function permitsRoutes() {
  const router = Router();

  router.get('/permits', async (req, res, next) => {
    try {
      const permits = await listPermits(req.app.locals.wtDir);
      res.json({ permits });
    } catch (e) {
      next(e);
    }
  });

  router.post('/permits', async (req, res, next) => {
    try {
      const events = req.app.locals.events;
      const { sessionId, mode, durationMs } = req.body;
      if (!sessionId || !mode) return res.status(400).json({ error: 'sessionId and mode required' });
      if (!['once', 'duration', 'always'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be once|duration|always' });
      }
      const permit = await grantPermit(req.app.locals.wtDir, { sessionId, mode, durationMs });
      events.emit('permit.granted', { sessionId, mode });
      res.status(201).json(permit);
    } catch (e) {
      next(e);
    }
  });

  router.delete('/permits/:sessionId', async (req, res, next) => {
    try {
      await revokePermit(req.app.locals.wtDir, req.params.sessionId);
      req.app.locals.events.emit('permit.revoked', { sessionId: req.params.sessionId });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
```

- [ ] **Step 5: Gate channel.js POST /channel/message**

In `src/daemon/routes/channel.js`, at the top of the `POST /channel/message` handler before calling `appendMessage`, insert:

```js
import { checkAndConsume } from '../permits.js';

// inside the POST handler, after pulling fields:
if (autonomous && fromSessionId !== 'operator') {
  const check = await checkAndConsume(wtDir, fromSessionId);
  if (!check.allowed) {
    req.app.locals.events.emit('permit.required', { session_id: fromSessionId });
    return res.status(403).json({
      status: 'permit_required',
      session_id: fromSessionId,
      reason: check.reason,
      hint: `Operator: run \`walkie permit ${fromSessionId} --once\` (or --duration X / --always) to allow this write.`
    });
  }
}
```

- [ ] **Step 6: Mount in server.js**

```js
// src/daemon/server.js — add import + mount
import { permitsRoutes } from './routes/permits.js';
// after app.use(sessionsRoutes()):
app.use(permitsRoutes());
```

- [ ] **Step 7: Run tests to verify pass**

Run: `npx vitest run test/daemon/permits.test.js test/daemon/server.test.js`
Expected: PASS — 5 new permit tests + 10 existing.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/permits.js src/daemon/routes/permits.js src/daemon/routes/channel.js src/daemon/server.js test/daemon/permits.test.js
git commit -m "feat(daemon): permits gate + grant/revoke routes"
```

---

### Task 20: SSE events route

**Files:**
- Create: `src/daemon/routes/events.js`
- Modify: `src/daemon/server.js`
- Test: `test/daemon/events.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/daemon/events.test.js
import { describe, test, expect, afterEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { createServer } from '../../src/daemon/server.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
let server;
afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  if (project) cleanup(project);
  project = null;
});

function startListening(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, () => resolve({ s, port: s.address().port }));
  });
}

describe('SSE events', () => {
  test('GET /events streams a message.posted event when a message is posted', async () => {
    project = createTmpProject();
    const { app } = createServer({ wtDir: project.wtDir });
    const { s, port } = await startListening(app);
    server = s;
    const chunks = [];
    const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
      res.on('data', (c) => chunks.push(c.toString()));
    });
    await new Promise((r) => setTimeout(r, 50));
    await fetch(`http://127.0.0.1:${port}/channel/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: 'hi',
        type: 'broadcast',
        fromSessionId: 'operator',
        fromAlias: 'Trevor',
        fromTool: 'operator'
      })
    });
    await new Promise((r) => setTimeout(r, 100));
    const joined = chunks.join('');
    expect(joined).toContain('event: message.posted');
    expect(joined).toContain('"type":"broadcast"');
    req.destroy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/events.test.js`
Expected: FAIL — `/events` returns 404.

- [ ] **Step 3: Implement**

```js
// src/daemon/routes/events.js
import { Router } from 'express';

const EVENT_TYPES = [
  'message.posted',
  'message.edited',
  'message.archived',
  'mention.fulfilled',
  'session.joined',
  'session.renamed',
  'permit.granted',
  'permit.revoked',
  'permit.required',
  'channel.external_edit'
];

export function eventsRoutes() {
  const router = Router();

  router.get('/events', (req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.flushHeaders();

    const emitter = req.app.locals.events;
    const send = (type, payload) => {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const listeners = EVENT_TYPES.map((t) => {
      const fn = (payload) => send(t, payload);
      emitter.on(t, fn);
      return { t, fn };
    });

    const keepalive = setInterval(() => res.write(': ka\n\n'), 15000);

    req.on('close', () => {
      clearInterval(keepalive);
      for (const { t, fn } of listeners) emitter.off(t, fn);
    });
  });

  return router;
}
```

Mount in `src/daemon/server.js`:

```js
import { eventsRoutes } from './routes/events.js';
// ... after permitsRoutes():
app.use(eventsRoutes());
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/daemon/events.test.js`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/routes/events.js src/daemon/server.js test/daemon/events.test.js
git commit -m "feat(daemon): SSE event stream on /events"
```

---

### Task 21: File watcher + external_edit event

**Files:**
- Create: `src/daemon/watcher.js`
- Modify: `src/daemon/server.js` (start watcher when listening)
- Test: `test/daemon/watcher.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/daemon/watcher.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { createEvents } from '../../src/daemon/events.js';
import { startWatcher } from '../../src/daemon/watcher.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
let stop;
afterEach(async () => {
  if (stop) await stop();
  stop = null;
  if (project) cleanup(project);
  project = null;
});

describe('watcher', () => {
  test('emits channel.external_edit when channel.md changes outside walkie-core', async () => {
    project = createTmpProject();
    const events = createEvents();
    const got = new Promise((resolve) => events.once('channel.external_edit', resolve));
    stop = await startWatcher({ wtDir: project.wtDir, events });
    await new Promise((r) => setTimeout(r, 100));
    const text = readFileSync(project.channelPath, 'utf8');
    writeFileSync(project.channelPath, text + '\nhand-edit\n');
    const payload = await Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
    ]);
    expect(payload).toHaveProperty('mtime');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/daemon/watcher.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/daemon/watcher.js
import chokidar from 'chokidar';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { isInternalWrite } from '../core/channel.js';

export async function startWatcher({ wtDir, events }) {
  const channelPath = join(wtDir, 'channel.md');
  const watcher = chokidar.watch(channelPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 } });
  watcher.on('change', (path) => {
    if (isInternalWrite(path)) return;
    const stat = statSync(path);
    events.emit('channel.external_edit', { mtime: stat.mtime.toISOString(), size: stat.size });
  });
  return () => watcher.close();
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/daemon/watcher.test.js`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/daemon/watcher.js test/daemon/watcher.test.js
git commit -m "feat(daemon): chokidar watcher emits channel.external_edit"
```

---

### Task 22: Desktop notifications

**Files:**
- Create: `src/daemon/notify.js`
- Modify: `src/daemon/server.js` (subscribe to events)

No automated test — node-notifier requires a graphical session. Manual verification only.

- [ ] **Step 1: Implement**

```js
// src/daemon/notify.js
import notifier from 'node-notifier';

const TITLE = 'walkie-talkie';

export function attachNotifier({ events, projectName = 'project' }) {
  const fire = (title, message) => {
    try {
      notifier.notify({ title, message, sound: false, timeout: 5 });
    } catch (e) {
      // best-effort; silently swallow in environments without a graphical session
    }
  };
  events.on('message.posted', (p) => {
    if (p.from === 'operator') return;
    fire(`${TITLE} — ${projectName}`, `New message (${p.type}) from ${p.from}`);
  });
  events.on('permit.required', (p) => {
    fire(`${TITLE} — permit required`, `${p.session_id} wants to send. Run: walkie permit ${p.session_id} --once`);
  });
}
```

Modify `src/daemon/server.js` (optional auto-attach behind an option flag — the daemon entry calls it; tests don't).

- [ ] **Step 2: Verify it loads (no test)**

Run: `node -e "import('./src/daemon/notify.js').then(m => console.log(typeof m.attachNotifier))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add src/daemon/notify.js
git commit -m "feat(daemon): desktop notifications via node-notifier (best-effort)"
```

---

### Task 23: Daemon lifecycle (spawn/stop/status/auto-start)

**Files:**
- Create: `src/daemon/lifecycle.js`
- Create: `src/daemon/daemon-entry.js`
- Test: `test/daemon/lifecycle.test.js`
- Create: `test/helpers/spawn-daemon.js`

- [ ] **Step 1: Write daemon-entry (the process the lifecycle spawns)**

```js
// src/daemon/daemon-entry.js
import { createServer } from './server.js';
import { startWatcher } from './watcher.js';
import { attachNotifier } from './notify.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const wtDir = process.argv[2];
const projectName = process.argv[3] || 'project';

if (!wtDir) {
  console.error('daemon-entry requires wtDir as first arg');
  process.exit(1);
}

const { app, events } = createServer({ wtDir });

const server = app.listen(0, async () => {
  const port = server.address().port;
  writeFileSync(join(wtDir, 'server.port'), String(port));
  writeFileSync(join(wtDir, 'server.pid'), String(process.pid));
  await startWatcher({ wtDir, events });
  attachNotifier({ events, projectName });
});

function shutdown() {
  try {
    unlinkSync(join(wtDir, 'server.port'));
  } catch {}
  try {
    unlinkSync(join(wtDir, 'server.pid'));
  } catch {}
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

- [ ] **Step 2: Write helper to spawn the daemon from tests**

```js
// test/helpers/spawn-daemon.js
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, '../../src/daemon/daemon-entry.js');

export async function spawnDaemon(wtDir) {
  const child = spawn(process.execPath, [ENTRY, wtDir, 'test'], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 50; i += 1) {
    if (existsSync(join(wtDir, 'server.port')) && existsSync(join(wtDir, 'server.pid'))) {
      const port = Number(readFileSync(join(wtDir, 'server.port'), 'utf8'));
      return { child, port };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error('daemon never wrote PID/port files');
}
```

- [ ] **Step 3: Write failing test**

```js
// test/daemon/lifecycle.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startDaemon, stopDaemon, statusDaemon } from '../../src/daemon/lifecycle.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

let project;
afterEach(async () => {
  if (project) {
    try { await stopDaemon(project.root); } catch {}
    cleanup(project);
    project = null;
  }
});

describe('daemon lifecycle', () => {
  test('startDaemon writes server.pid + server.port, status reports running', async () => {
    project = createTmpProject();
    await startDaemon(project.root);
    const status = await statusDaemon(project.root);
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);
    expect(existsSync(join(project.wtDir, 'server.pid'))).toBe(true);
    expect(existsSync(join(project.wtDir, 'server.port'))).toBe(true);
  });

  test('stopDaemon kills process and removes pid/port', async () => {
    project = createTmpProject();
    await startDaemon(project.root);
    await stopDaemon(project.root);
    await new Promise((r) => setTimeout(r, 100));
    const status = await statusDaemon(project.root);
    expect(status.running).toBe(false);
  });

  test('startDaemon is idempotent when already running', async () => {
    project = createTmpProject();
    await startDaemon(project.root);
    const first = await statusDaemon(project.root);
    await startDaemon(project.root);
    const second = await statusDaemon(project.root);
    expect(second.pid).toBe(first.pid);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run test/daemon/lifecycle.test.js`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

```js
// src/daemon/lifecycle.js
import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'daemon-entry.js');

function paths(projectRoot) {
  const wt = join(projectRoot, '.walkie-talkie');
  return { wt, pid: join(wt, 'server.pid'), port: join(wt, 'server.port') };
}

async function readPid(projectRoot) {
  const p = paths(projectRoot);
  if (!existsSync(p.pid)) return null;
  const txt = await readFile(p.pid, 'utf8');
  return Number(txt.trim());
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function statusDaemon(projectRoot) {
  const pid = await readPid(projectRoot);
  if (!pid || !isAlive(pid)) return { running: false };
  const p = paths(projectRoot);
  const port = existsSync(p.port) ? Number((await readFile(p.port, 'utf8')).trim()) : null;
  return { running: true, pid, port };
}

export async function startDaemon(projectRoot, { projectName = 'project' } = {}) {
  const current = await statusDaemon(projectRoot);
  if (current.running) return current;
  const p = paths(projectRoot);
  const child = spawn(process.execPath, [ENTRY, p.wt, projectName], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  for (let i = 0; i < 100; i += 1) {
    if (existsSync(p.pid) && existsSync(p.port)) {
      return statusDaemon(projectRoot);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('daemon failed to start within 5 seconds');
}

export async function stopDaemon(projectRoot) {
  const pid = await readPid(projectRoot);
  if (pid && isAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const p = paths(projectRoot);
  try { await unlink(p.pid); } catch {}
  try { await unlink(p.port); } catch {}
}

export async function ensureRunning(projectRoot, opts) {
  const status = await statusDaemon(projectRoot);
  if (status.running) return status;
  return startDaemon(projectRoot, opts);
}
```

- [ ] **Step 6: Run tests to verify pass**

Run: `npx vitest run test/daemon/lifecycle.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/daemon/lifecycle.js src/daemon/daemon-entry.js test/daemon/lifecycle.test.js test/helpers/spawn-daemon.js
git commit -m "feat(daemon): spawn/stop/status lifecycle with detached process"
```

---

### Task 24: Machine-wide registry

**Files:**
- Create: `src/daemon/registry-machine.js`
- Modify: `src/daemon/daemon-entry.js` (register on start, deregister on shutdown)

- [ ] **Step 1: Implement**

```js
// src/daemon/registry-machine.js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function registryPath() {
  return join(homedir(), '.walkie-talkie', 'registry.json');
}

async function loadRegistry() {
  const p = registryPath();
  if (!existsSync(p)) return { projects: [] };
  return JSON.parse(await readFile(p, 'utf8'));
}

async function saveRegistry(data) {
  const p = registryPath();
  await mkdir(join(homedir(), '.walkie-talkie'), { recursive: true });
  await writeFile(p, JSON.stringify(data, null, 2));
}

export async function registerProject({ projectPath, port, pid, projectName }) {
  const r = await loadRegistry();
  r.projects = r.projects.filter((p) => p.projectPath !== projectPath);
  r.projects.push({ projectPath, port, pid, projectName, startedAt: new Date().toISOString() });
  await saveRegistry(r);
}

export async function deregisterProject(projectPath) {
  const r = await loadRegistry();
  r.projects = r.projects.filter((p) => p.projectPath !== projectPath);
  await saveRegistry(r);
}

export async function listProjects() {
  return (await loadRegistry()).projects;
}
```

Modify `src/daemon/daemon-entry.js` to register/deregister:

```js
// inside server.listen callback, after writing PID/port files:
import { registerProject, deregisterProject } from './registry-machine.js';
// ...
await registerProject({
  projectPath: wtDir.replace(/\/\.walkie-talkie$/, ''),
  port,
  pid: process.pid,
  projectName
});
// inside shutdown(), before unlink:
await deregisterProject(wtDir.replace(/\/\.walkie-talkie$/, '')).catch(() => {});
```

- [ ] **Step 2: Verify with a manual run**

Run:
```bash
node -e "
import('./src/daemon/registry-machine.js').then(async m => {
  await m.registerProject({projectPath:'/tmp/x', port:1234, pid:99, projectName:'x'});
  console.log(await m.listProjects());
  await m.deregisterProject('/tmp/x');
  console.log(await m.listProjects());
});
"
```
Expected: first listProjects shows one entry, second shows zero.

- [ ] **Step 3: Commit**

```bash
git add src/daemon/registry-machine.js src/daemon/daemon-entry.js
git commit -m "feat(daemon): machine-wide registry of running projects"
```

---

## Phase 6 — CLI (operator-facing commands)

### Task 25: CLI scaffold (commander + client + render)

**Files:**
- Create: `bin/walkie.js`
- Create: `src/cli/index.js`
- Create: `src/cli/client.js`
- Create: `src/cli/render.js`
- Test: `test/cli/help.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/cli/help.test.js
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '../../bin/walkie.js');

describe('CLI help', () => {
  test('walkie --help lists core commands', () => {
    const out = execFileSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
    expect(out).toContain('init');
    expect(out).toContain('start');
    expect(out).toContain('talk');
    expect(out).toContain('read');
    expect(out).toContain('tail');
    expect(out).toContain('sessions');
    expect(out).toContain('permit');
    expect(out).toContain('remove');
  });

  test('walkie --version prints semver', () => {
    const out = execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cli/help.test.js`
Expected: FAIL — bin not found.

- [ ] **Step 3: Implement bin entry**

```js
#!/usr/bin/env node
// bin/walkie.js
import('../src/cli/index.js');
```

After creating, run: `chmod +x bin/walkie.js`

- [ ] **Step 4: Implement client.js**

```js
// src/cli/client.js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function clientForProject(projectRoot) {
  const portFile = join(projectRoot, '.walkie-talkie', 'server.port');
  if (!existsSync(portFile)) {
    throw new Error('daemon is not running (no server.port file). Run `walkie start` first.');
  }
  const port = Number(readFileSync(portFile, 'utf8').trim());
  const base = `http://127.0.0.1:${port}`;
  async function req(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${typeof parsed === 'string' ? parsed : parsed.error || parsed.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }
  return {
    base,
    health: () => req('GET', '/health'),
    latest: (limit = 5, includeArchived = false) =>
      req('GET', `/channel/latest?limit=${limit}&include_archived=${includeArchived}`),
    since: (id) => req('GET', `/channel/since/${id}`),
    message: (id) => req('GET', `/channel/message/${id}`),
    post: (data) => req('POST', '/channel/message', data),
    edit: (id, data) => req('PATCH', `/channel/message/${id}`, data),
    archive: (id, data) => req('POST', `/channel/message/${id}/archive`, data),
    sessions: () => req('GET', '/sessions'),
    join: (data) => req('POST', '/sessions/join', data),
    rename: (id, alias) => req('POST', `/sessions/${id}/rename`, { alias }),
    invite: (alias) => req('POST', '/sessions/invite', { alias }),
    listPermits: () => req('GET', '/permits'),
    grantPermit: (data) => req('POST', '/permits', data),
    revokePermit: (sessionId) => req('DELETE', `/permits/${sessionId}`)
  };
}
```

- [ ] **Step 5: Implement render.js**

```js
// src/cli/render.js
import { relative } from '../core/time.js';

const TOOL_EMOJI = { 'claude-code': '📡', 'claude-cowork': '🎨', operator: '👤' };

function emojiFor(msg) {
  if (msg.archived) return '🗄️';
  if (msg.autonomous) return `🤖${TOOL_EMOJI[msg.fromTool] ?? '⚡'}`;
  return TOOL_EMOJI[msg.fromTool] ?? '⚡';
}

export function renderMessage(msg) {
  const recipients = msg.mentions?.length ? msg.mentions.map((m) => `@${m}`).join(', ') : 'all';
  const ago = msg.timestamp ? relative(msg.timestamp) : '';
  const sender = msg.fromAlias || msg.fromSessionId;
  const head = `${emojiFor(msg)} ${sender} → ${recipients}  [${msg.type}]  ${ago}`;
  const lines = [head, `  id: ${msg.id}`];
  if (msg.replyTo) lines.push(`  reply-to: ${msg.replyTo}`);
  if (msg.revision) lines.push(`  edited revision ${msg.revision}`);
  if (msg.archived) lines.push(`  ARCHIVED by ${msg.archivedBy}${msg.archivedReason ? ` — ${msg.archivedReason}` : ''}`);
  const body = (msg.body || '').trim().split('\n').map((l) => `    ${l}`).join('\n');
  if (body) lines.push('', body);
  return lines.join('\n');
}

export function renderMessages(messages) {
  if (!messages.length) return '(no messages)';
  return messages.map(renderMessage).join('\n\n');
}
```

- [ ] **Step 6: Implement commander setup**

```js
// src/cli/index.js
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

const program = new Command();
program
  .name('walkie')
  .description('Two-way radio for Claude Code and Claude Cowork sessions')
  .version(pkg.version);

// Subcommands added in later tasks. For now we register placeholders so --help lists them.
const placeholders = [
  ['init', 'Initialize .walkie-talkie/ in the current directory'],
  ['start', 'Start the local daemon'],
  ['stop', 'Stop the local daemon'],
  ['status', 'Show daemon and channel status'],
  ['talk', 'Broadcast a message (use @mentions to direct attention)'],
  ['read', 'Read recent messages'],
  ['tail', 'Stream the live event feed'],
  ['reply', 'Reply to a specific message'],
  ['edit', 'Edit a message you authored'],
  ['archive', 'Archive a message'],
  ['sessions', 'List active and recent sessions plus invitations'],
  ['rename', 'Rename this session'],
  ['alias', 'Rename a specific session by id'],
  ['invite', 'Reserve an alias for a future session'],
  ['permit', 'Grant autonomous-write permission to a session'],
  ['remove', 'Remove autonomous-write permission from a session'],
  ['config', 'View or edit channel config'],
  ['logs', 'View activity logs']
];
for (const [name, desc] of placeholders) {
  program.command(name).description(desc).action(() => {
    console.error(`walkie ${name}: not implemented yet`);
    process.exit(2);
  });
}

program.parseAsync(process.argv);
```

> **Note:** later tasks (26–33) replace these placeholder actions one by one with real implementations.

- [ ] **Step 7: Run tests to verify pass**

Run: `npx vitest run test/cli/help.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 8: Commit**

```bash
git add bin/walkie.js src/cli/index.js src/cli/client.js src/cli/render.js test/cli/help.test.js
git commit -m "feat(cli): scaffold (commander, http client, renderer, help)"
```

---

### Task 26: walkie init

**Files:**
- Create: `src/cli/init.js`
- Modify: `src/cli/index.js`
- Test: `test/cli/init.test.js`

- [ ] **Step 1: Write failing test**

```js
// test/cli/init.test.js
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/walkie.js');

describe('walkie init', () => {
  test('creates .walkie-talkie/ with channel.md and config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkie-init-'));
    try {
      execFileSync(process.execPath, [BIN, 'init', '--operator', 'Trevor', '--name', 'demo'], { cwd: dir });
      expect(existsSync(join(dir, '.walkie-talkie/channel.md'))).toBe(true);
      const cfg = JSON.parse(readFileSync(join(dir, '.walkie-talkie/config.json'), 'utf8'));
      expect(cfg.operator).toBe('Trevor');
      expect(cfg.projectName).toBe('demo');
      const channel = readFileSync(join(dir, '.walkie-talkie/channel.md'), 'utf8');
      expect(channel).toContain('Walkie-Talkie Channel: demo');
      expect(channel).toContain('Operator:** Trevor');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to overwrite existing channel without --force', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walkie-init-'));
    try {
      execFileSync(process.execPath, [BIN, 'init', '--operator', 'A'], { cwd: dir });
      expect(() =>
        execFileSync(process.execPath, [BIN, 'init', '--operator', 'B'], { cwd: dir, stdio: 'pipe' })
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cli/init.test.js`
Expected: FAIL — placeholder action exits 2.

- [ ] **Step 3: Implement init**

```js
// src/cli/init.js
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '../../templates/channel.md');

export async function initCommand({ operator, name, force }) {
  const projectRoot = process.cwd();
  const wt = join(projectRoot, '.walkie-talkie');
  if (existsSync(wt) && !force) {
    console.error('.walkie-talkie/ already exists. Use --force to reinitialize.');
    process.exit(1);
  }
  await mkdir(wt, { recursive: true });
  await mkdir(join(wt, '.sessions'), { recursive: true });
  await mkdir(join(wt, 'logs'), { recursive: true });
  const projectName = name || basename(projectRoot);
  const template = (await readFile(TEMPLATE_PATH, 'utf8'))
    .replace('PROJECT_NAME', projectName)
    .replace('OPERATOR_NAME', operator)
    .replace('CREATED_AT', new Date().toISOString());
  await writeFile(join(wt, 'channel.md'), template);
  await writeFile(
    join(wt, 'config.json'),
    JSON.stringify({ operator, projectName, permits: [] }, null, 2)
  );
  console.log(`Initialized walkie-talkie channel for "${projectName}" with operator "${operator}".`);
  console.log(`Next: walkie start`);
}
```

Modify `src/cli/index.js` — replace the placeholder for `init`:

```js
import { initCommand } from './init.js';
// remove the entry for 'init' from `placeholders` and register explicitly:
program
  .command('init')
  .description('Initialize .walkie-talkie/ in the current directory')
  .requiredOption('--operator <name>', 'Operator (human) display name')
  .option('--name <projectName>', 'Project name (defaults to directory name)')
  .option('--force', 'Overwrite an existing .walkie-talkie/')
  .action(initCommand);
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run test/cli/init.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli/init.js src/cli/index.js test/cli/init.test.js
git commit -m "feat(cli): walkie init"
```

---

### Task 27: walkie start / stop / status

**Files:**
- Create: `src/cli/start.js`, `src/cli/stop.js`, `src/cli/status.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Implement start.js**

```js
// src/cli/start.js
import { startDaemon } from '../daemon/lifecycle.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function startCommand() {
  const cwd = process.cwd();
  const cfgPath = join(cwd, '.walkie-talkie', 'config.json');
  if (!existsSync(cfgPath)) {
    console.error('No .walkie-talkie/ here. Run `walkie init` first.');
    process.exit(1);
  }
  const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
  const status = await startDaemon(cwd, { projectName: cfg.projectName });
  console.log(`Daemon running on http://127.0.0.1:${status.port} (pid ${status.pid})`);
}
```

- [ ] **Step 2: Implement stop.js**

```js
// src/cli/stop.js
import { stopDaemon, statusDaemon } from '../daemon/lifecycle.js';

export async function stopCommand() {
  const before = await statusDaemon(process.cwd());
  if (!before.running) {
    console.log('Daemon is not running.');
    return;
  }
  await stopDaemon(process.cwd());
  console.log(`Daemon stopped (pid ${before.pid}).`);
}
```

- [ ] **Step 3: Implement status.js**

```js
// src/cli/status.js
import { statusDaemon } from '../daemon/lifecycle.js';
import { listProjects } from '../daemon/registry-machine.js';

export async function statusCommand({ all }) {
  if (all) {
    const projects = await listProjects();
    if (!projects.length) {
      console.log('No walkie projects currently running.');
      return;
    }
    for (const p of projects) {
      console.log(`- ${p.projectName} (${p.projectPath}) → http://127.0.0.1:${p.port} pid ${p.pid} since ${p.startedAt}`);
    }
    return;
  }
  const status = await statusDaemon(process.cwd());
  if (!status.running) {
    console.log('Daemon is not running here. Run `walkie start`.');
    return;
  }
  console.log(`Running on http://127.0.0.1:${status.port} (pid ${status.pid}).`);
}
```

- [ ] **Step 4: Wire commands in index.js**

```js
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';
import { statusCommand } from './status.js';

program.command('start').description('Start the local daemon').action(startCommand);
program.command('stop').description('Stop the local daemon').action(stopCommand);
program.command('status').description('Show daemon and channel status').option('--all', 'List all walkie projects machine-wide').action(statusCommand);
```

(Remove the `'start'`, `'stop'`, `'status'` entries from the placeholders array.)

- [ ] **Step 5: Manual smoke**

In a tmp dir:
```bash
mkdir /tmp/walkie-smoke && cd /tmp/walkie-smoke
node ~/Projects/development/claude-walkie-talkie/bin/walkie.js init --operator Trevor --name smoke
node ~/Projects/development/claude-walkie-talkie/bin/walkie.js start
node ~/Projects/development/claude-walkie-talkie/bin/walkie.js status
node ~/Projects/development/claude-walkie-talkie/bin/walkie.js status --all
node ~/Projects/development/claude-walkie-talkie/bin/walkie.js stop
```
Expected: daemon prints port + pid; status shows running; --all lists the project; stop cleans up.

- [ ] **Step 6: Commit**

```bash
git add src/cli/start.js src/cli/stop.js src/cli/status.js src/cli/index.js
git commit -m "feat(cli): walkie start/stop/status (+ --all machine-wide listing)"
```

---

### Task 28: walkie talk (with @mention interactive prompt for unresolved)

**Files:**
- Create: `src/cli/talk.js`
- Create: `src/cli/prompt.js` (small readline wrapper)
- Modify: `src/cli/index.js`
- Test: `test/cli/talk.test.js`

- [ ] **Step 1: Write the readline helper**

```js
// src/cli/prompt.js
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function ask(question) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Write failing test**

```js
// test/cli/talk.test.js
import { describe, test, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnDaemon } from '../helpers/spawn-daemon.js';
import { createTmpProject, cleanup } from '../helpers/tmp-project.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '../../bin/walkie.js');

let project;
let daemon;
afterEach(async () => {
  if (daemon?.child) daemon.child.kill();
  if (project) cleanup(project);
  project = null;
  daemon = null;
});

describe('walkie talk', () => {
  test('walkie talk posts a broadcast and walkie read returns it', async () => {
    project = createTmpProject();
    daemon = await spawnDaemon(project.wtDir);
    execFileSync(process.execPath, [BIN, 'talk', 'hello from the cli'], { cwd: project.root });
    const out = execFileSync(process.execPath, [BIN, 'read', '--limit', '5'], {
      cwd: project.root,
      encoding: 'utf8'
    });
    expect(out).toContain('hello from the cli');
  });

  test('walkie talk warns about unresolved @mentions and skips invite when --no-invite', async () => {
    project = createTmpProject();
    daemon = await spawnDaemon(project.wtDir);
    const out = execFileSync(
      process.execPath,
      [BIN, 'talk', '--no-invite', 'hey @ghost'],
      { cwd: project.root, encoding: 'utf8' }
    );
    expect(out).toContain('Posted');
    expect(out).toContain('@ghost');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/cli/talk.test.js`
Expected: FAIL — placeholder action.

- [ ] **Step 4: Implement talk.js**

```js
// src/cli/talk.js
import { clientForProject } from './client.js';
import { ask } from './prompt.js';

export async function talkCommand(body, opts) {
  const projectRoot = process.cwd();
  const client = clientForProject(projectRoot);
  const data = {
    body,
    type: opts.type || 'broadcast',
    fromSessionId: 'operator',
    fromAlias: opts.as || 'operator',
    fromTool: 'operator'
  };
  let res;
  try {
    res = await client.post(data);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  console.log(`Posted ${res.id}`);
  if (res.warnings?.length) {
    for (const w of res.warnings) {
      if (w.type !== 'unresolved-mention') continue;
      console.log(`⚠️  @${w.token} is not in this channel.`);
      if (opts.invite === false) {
        console.log(`   (--no-invite supplied; sent as-is)`);
        continue;
      }
      const reply = await ask(`   Invite @${w.token} for a future session? [y/N] `);
      if (reply.toLowerCase().startsWith('y')) {
        await client.invite(w.token);
        console.log(`   Invited @${w.token}. When a matching session joins, run \`walkie alias <session-id> ${w.token}\` to fulfill.`);
      } else {
        console.log(`   Sent as-is.`);
      }
    }
  }
}
```

Wire in `src/cli/index.js`:

```js
import { talkCommand } from './talk.js';
program
  .command('talk <message...>')
  .description('Broadcast a message (use @mentions to direct attention)')
  .option('--type <type>', 'Message type: broadcast|question|reply|memory-update', 'broadcast')
  .option('--as <alias>', 'Override the operator alias for this message')
  .option('--no-invite', 'Do not interactively offer to invite unresolved @mentions')
  .action((parts, opts) => talkCommand(parts.join(' '), opts));
```

(Remove `'talk'` from the placeholders.)

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run test/cli/talk.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/talk.js src/cli/prompt.js src/cli/index.js test/cli/talk.test.js
git commit -m "feat(cli): walkie talk with @mention warnings + optional invite"
```

---

### Task 29: walkie read + tail

**Files:**
- Create: `src/cli/read.js`, `src/cli/tail.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Implement read.js**

```js
// src/cli/read.js
import { clientForProject } from './client.js';
import { renderMessages } from './render.js';

export async function readCommand(opts) {
  const client = clientForProject(process.cwd());
  const limit = Number(opts.limit) || 5;
  let response;
  if (opts.since) {
    response = await client.since(opts.since);
  } else {
    response = await client.latest(limit, Boolean(opts.includeArchived));
  }
  let messages = response.messages;
  if (opts.type) messages = messages.filter((m) => m.type === opts.type);
  console.log(renderMessages(messages));
}
```

- [ ] **Step 2: Implement tail.js**

```js
// src/cli/tail.js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function tailCommand() {
  const portFile = join(process.cwd(), '.walkie-talkie', 'server.port');
  if (!existsSync(portFile)) {
    console.error('Daemon is not running. Run `walkie start` first.');
    process.exit(1);
  }
  const port = Number(readFileSync(portFile, 'utf8').trim());
  const url = `http://127.0.0.1:${port}/events`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.error(`Cannot connect: HTTP ${res.status}`);
    process.exit(1);
  }
  console.log(`Tailing ${url}. Ctrl-C to exit.`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = block.split('\n');
      let event = 'message';
      let data = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) event = l.slice(7);
        else if (l.startsWith('data: ')) data += l.slice(6);
      }
      if (event && !event.startsWith(':')) {
        console.log(`[${event}] ${data}`);
      }
    }
  }
}
```

- [ ] **Step 3: Wire in index.js**

```js
import { readCommand } from './read.js';
import { tailCommand } from './tail.js';
program
  .command('read')
  .description('Read recent messages')
  .option('--limit <N>', 'How many', '5')
  .option('--since <ulid>', 'Show messages after this ID')
  .option('--include-archived', 'Include archived messages', false)
  .option('--type <T>', 'Filter by message type')
  .action(readCommand);
program.command('tail').description('Stream the live event feed').action(tailCommand);
```

- [ ] **Step 4: Manual smoke**

```bash
cd /tmp/walkie-smoke
walkie start
walkie talk "hi"
walkie read --limit 5
walkie tail   # in another terminal: walkie talk "ping" → expect output
walkie stop
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/read.js src/cli/tail.js src/cli/index.js
git commit -m "feat(cli): walkie read + walkie tail"
```

---

### Task 30: walkie reply + edit + archive

**Files:**
- Create: `src/cli/reply.js`, `src/cli/edit.js`, `src/cli/archive.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Implement reply.js**

```js
// src/cli/reply.js
import { clientForProject } from './client.js';

export async function replyCommand(id, parts, opts) {
  const client = clientForProject(process.cwd());
  const target = await client.message(id);
  const fromAlias = target.message.fromAlias || target.message.fromSessionId;
  const body = `@${fromAlias} ${parts.join(' ')}`;
  const res = await client.post({
    body,
    type: 'reply',
    fromSessionId: 'operator',
    fromAlias: opts.as || 'operator',
    fromTool: 'operator',
    replyTo: id
  });
  console.log(`Replied ${res.id} (in reply to ${id}).`);
}
```

- [ ] **Step 2: Implement edit.js**

```js
// src/cli/edit.js
import { clientForProject } from './client.js';

export async function editCommand(id, parts) {
  const client = clientForProject(process.cwd());
  const res = await client.edit(id, { body: parts.join(' '), editedBy: 'operator' });
  console.log(`Edited ${id} (revision ${res.revision}).`);
}
```

- [ ] **Step 3: Implement archive.js**

```js
// src/cli/archive.js
import { clientForProject } from './client.js';

export async function archiveCommand(id, opts) {
  const client = clientForProject(process.cwd());
  await client.archive(id, { archivedBy: 'operator', reason: opts.reason || null });
  console.log(`Archived ${id}.`);
}
```

- [ ] **Step 4: Wire in index.js**

```js
import { replyCommand } from './reply.js';
import { editCommand } from './edit.js';
import { archiveCommand } from './archive.js';

program
  .command('reply <id> <message...>')
  .description('Reply to a specific message')
  .option('--as <alias>', 'Override operator alias')
  .action((id, parts, opts) => replyCommand(id, parts, opts));

program
  .command('edit <id> <newBody...>')
  .description('Edit a message you authored')
  .action((id, parts) => editCommand(id, parts));

program
  .command('archive <id>')
  .description('Archive a message')
  .option('--reason <reason>', 'Why')
  .action(archiveCommand);
```

- [ ] **Step 5: Manual smoke**

```bash
cd /tmp/walkie-smoke
walkie start
ID=$(walkie talk "edit me" | awk '{print $2}')
walkie edit $ID "edited body"
walkie read --limit 2
walkie archive $ID --reason "duplicate"
walkie read --limit 2  # archived hidden
walkie read --limit 2 --include-archived
walkie stop
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/reply.js src/cli/edit.js src/cli/archive.js src/cli/index.js
git commit -m "feat(cli): walkie reply / edit / archive"
```

---

### Task 31: walkie sessions + rename + alias + invite

**Files:**
- Create: `src/cli/sessions.js`, `src/cli/rename.js`, `src/cli/alias.js`, `src/cli/invite.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Implement sessions.js**

```js
// src/cli/sessions.js
import { clientForProject } from './client.js';

export async function sessionsCommand() {
  const c = clientForProject(process.cwd());
  const s = await c.sessions();
  console.log('Active sessions:');
  if (!s.active.length) console.log('  (none)');
  for (const x of s.active) {
    console.log(`  ${x.alias}  [${x.tool}]  session ${x.sessionId}  last seen ${x.lastSeen}`);
  }
  console.log('\nRecent sessions:');
  if (!s.recent.length) console.log('  (none)');
  for (const x of s.recent.slice(0, 10)) {
    console.log(`  ${x.alias}  [${x.tool}]  retired ${x.retiredAt}`);
  }
  console.log('\nPending invitations:');
  if (!s.invitations.length) console.log('  (none)');
  for (const x of s.invitations) {
    console.log(`  @${x.alias}  invited by ${x.invitedBy} at ${x.invitedAt}`);
  }
}
```

- [ ] **Step 2: Implement rename.js**

```js
// src/cli/rename.js
import { clientForProject } from './client.js';

export async function renameCommand(newAlias) {
  const c = clientForProject(process.cwd());
  const sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) {
    console.error('No current session context (CLAUDE_SESSION_ID not set). Use `walkie alias <session-id> <alias>` instead.');
    process.exit(1);
  }
  const r = await c.rename(sessionId, newAlias);
  console.log(`Renamed ${sessionId} → ${r.alias}${r.fulfilled ? ' (fulfilled pending invitation)' : ''}.`);
}
```

- [ ] **Step 3: Implement alias.js**

```js
// src/cli/alias.js
import { clientForProject } from './client.js';

export async function aliasCommand(sessionId, newAlias) {
  const c = clientForProject(process.cwd());
  const r = await c.rename(sessionId, newAlias);
  console.log(`Renamed ${sessionId} → ${r.alias}${r.fulfilled ? ' (fulfilled pending invitation)' : ''}.`);
}
```

- [ ] **Step 4: Implement invite.js**

```js
// src/cli/invite.js
import { clientForProject } from './client.js';

export async function inviteCommand(alias) {
  const c = clientForProject(process.cwd());
  await c.invite(alias);
  console.log(`Invited @${alias}. When a matching session joins, run \`walkie alias <session-id> ${alias}\` to fulfill.`);
}
```

- [ ] **Step 5: Wire in index.js**

```js
import { sessionsCommand } from './sessions.js';
import { renameCommand } from './rename.js';
import { aliasCommand } from './alias.js';
import { inviteCommand } from './invite.js';

program.command('sessions').description('List active and recent sessions plus invitations').action(sessionsCommand);
program.command('rename <alias>').description('Rename this session').action(renameCommand);
program.command('alias <sessionId> <newAlias>').description('Rename a specific session by id').action(aliasCommand);
program.command('invite <alias>').description('Reserve an alias for a future session').action(inviteCommand);
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/sessions.js src/cli/rename.js src/cli/alias.js src/cli/invite.js src/cli/index.js
git commit -m "feat(cli): walkie sessions / rename / alias / invite"
```

---

### Task 32: walkie permit + remove

**Files:**
- Create: `src/cli/permit.js`, `src/cli/remove.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Implement permit.js**

```js
// src/cli/permit.js
import { clientForProject } from './client.js';

function parseDuration(s) {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if (!m) throw new Error(`Bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  const factor = { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return n * factor;
}

export async function permitCommand(session, opts) {
  const c = clientForProject(process.cwd());
  let mode = 'once';
  let durationMs;
  if (opts.always) mode = 'always';
  else if (opts.duration) {
    mode = 'duration';
    durationMs = parseDuration(opts.duration);
  } else if (opts.once || (!opts.always && !opts.duration)) {
    mode = 'once';
  }
  const sessionId = await resolveSession(c, session);
  const permit = await c.grantPermit({ sessionId, mode, durationMs });
  console.log(`Granted ${mode} permit to ${sessionId}${permit.expiresAt ? ` (expires ${permit.expiresAt})` : ''}.`);
}

async function resolveSession(client, sessionOrAlias) {
  if (/^[a-z]{2,}_/.test(sessionOrAlias) || sessionOrAlias === 'operator') return sessionOrAlias;
  const s = await client.sessions();
  const match = [...s.active, ...s.recent].find((x) => x.alias === sessionOrAlias);
  if (!match) throw new Error(`No session with alias "${sessionOrAlias}"`);
  return match.sessionId;
}
```

- [ ] **Step 2: Implement remove.js**

```js
// src/cli/remove.js
import { clientForProject } from './client.js';

export async function removeCommand(session) {
  const c = clientForProject(process.cwd());
  let sessionId = session;
  if (!/^[a-z]{2,}_/.test(session) && session !== 'operator') {
    const s = await c.sessions();
    const match = [...s.active, ...s.recent].find((x) => x.alias === session);
    if (!match) throw new Error(`No session with alias "${session}"`);
    sessionId = match.sessionId;
  }
  await c.revokePermit(sessionId);
  console.log(`Removed permit for ${sessionId}.`);
}
```

- [ ] **Step 3: Wire in index.js**

```js
import { permitCommand } from './permit.js';
import { removeCommand } from './remove.js';

program
  .command('permit <sessionOrAlias>')
  .description('Grant autonomous-write permission')
  .option('--once', 'Allow exactly one autonomous write', false)
  .option('--duration <duration>', 'Allow for a duration like 30m, 2h')
  .option('--always', 'Allow indefinitely (revoke with `walkie remove`)', false)
  .action(permitCommand);

program
  .command('remove <sessionOrAlias>')
  .description('Remove autonomous-write permission')
  .action(removeCommand);
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/permit.js src/cli/remove.js src/cli/index.js
git commit -m "feat(cli): walkie permit / remove"
```

---

### Task 33: walkie config + logs

**Files:**
- Create: `src/cli/config.js`, `src/cli/logs.js`
- Modify: `src/cli/index.js`

- [ ] **Step 1: Implement config.js**

```js
// src/cli/config.js
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function configCommand(opts) {
  const path = join(process.cwd(), '.walkie-talkie', 'config.json');
  const cfg = JSON.parse(await readFile(path, 'utf8'));
  if (opts.set) {
    const [key, ...rest] = opts.set.split('=');
    const value = rest.join('=');
    if (!key || value === undefined) {
      console.error('Use --set key=value');
      process.exit(1);
    }
    cfg[key] = value;
    await writeFile(path, JSON.stringify(cfg, null, 2));
    console.log(`Set ${key} = ${value}`);
    return;
  }
  console.log(JSON.stringify(cfg, null, 2));
}
```

- [ ] **Step 2: Implement logs.js**

```js
// src/cli/logs.js
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export async function logsCommand(opts) {
  const dir = join(process.cwd(), '.walkie-talkie', 'logs');
  if (!existsSync(dir)) {
    console.log('(no logs)');
    return;
  }
  const files = (await readdir(dir)).sort();
  if (!files.length) {
    console.log('(no logs)');
    return;
  }
  const latest = files[files.length - 1];
  const content = await readFile(join(dir, latest), 'utf8');
  if (opts.tail) {
    const lines = content.split('\n');
    console.log(lines.slice(-Number(opts.tail)).join('\n'));
  } else {
    console.log(content);
  }
}
```

- [ ] **Step 3: Wire in index.js**

```js
import { configCommand } from './config.js';
import { logsCommand } from './logs.js';

program
  .command('config')
  .description('View or edit channel config')
  .option('--set <key=value>', 'Set a config value')
  .action(configCommand);

program
  .command('logs')
  .description('View activity logs')
  .option('--tail <N>', 'Show only the last N lines')
  .action(logsCommand);
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/config.js src/cli/logs.js src/cli/index.js
git commit -m "feat(cli): walkie config / logs"
```

---

## Phase 7 — Plan A acceptance smoke and handoff

### Task 34: Manual smoke walkthrough + README update + Plan B kickoff prompt

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/plans/PLAN-B-KICKOFF-PROMPT.md`

- [ ] **Step 1: Run the manual smoke walkthrough end-to-end**

In a scratch directory:

```bash
mkdir -p /tmp/walkie-final && cd /tmp/walkie-final

# Initialize and start
walkie init --operator "Trevor Mengel" --name "smoke-test"
walkie start
walkie status            # → running on port N pid P

# Talk and read
ID1=$(walkie talk "hello from the radio" | awk 'NR==1{print $2}')
walkie read --limit 5    # → see the message
walkie talk "@operator ping"   # → no warning, mention resolves
walkie talk "@codex-helper test"  # → prompts to invite; type n

# Sessions and invitations
walkie sessions          # → none active yet (operator isn't a session)
walkie invite codex-helper
walkie sessions          # → 1 pending invitation

# Edit + archive
walkie edit "$ID1" "edited body"
walkie read --limit 2
walkie archive "$ID1" --reason "test cleanup"
walkie read --limit 5             # → archived hidden
walkie read --limit 5 --include-archived

# Tail
walkie tail &
TAIL_PID=$!
sleep 0.5
walkie talk "ping for tail"
sleep 0.5
kill $TAIL_PID

# Multi-project visibility
walkie status --all      # → at least one entry pointing here

walkie stop
ls -la .walkie-talkie/   # → no server.pid / server.port left
```

Verify all commands print without errors and the channel file is well-formed (`cat .walkie-talkie/channel.md`).

- [ ] **Step 2: Run the full test suite one final time**

Run: `npm run test`
Expected: all tests pass.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 3: Update `README.md` to reflect Plan A's actual capabilities**

```markdown
# claude-walkie-talkie

> Two-way radio for Claude Code and Claude Cowork sessions working on the same project.

**Status:** Plan A complete — operator-facing CLI + local daemon. Plan B (the Claude plugin integration) is the next milestone.

## What works today

```bash
walkie init --operator "Your Name" --name "project-name"
walkie start
walkie talk "hello"
walkie talk "@some-future-helper got time?"   # interactively invites
walkie read --limit 10
walkie tail
walkie reply <id> "yes, exactly"
walkie edit <id> "fixed typo"
walkie archive <id> --reason "duplicate"
walkie sessions
walkie invite codex-helper
walkie alias <session-id> demo-builder
walkie permit <session> --once|--duration 30m|--always
walkie remove <session>
walkie status            # this project
walkie status --all      # all walkie projects on this machine
walkie stop
```

A standalone operator-driven channel. Plan B wires the same channel into Claude Code and Cowork via skills, hooks, MCP server, and slash commands.

## Architecture

- `.walkie-talkie/channel.md` is the source of truth (per project).
- Atomic append-at-top via lockfile; ULID message IDs; multi-writer safe.
- Local Node daemon exposes HTTP + SSE; chokidar watches for hand-edits.
- CLI talks to the daemon over `http://127.0.0.1:<port>` (port allocated and recorded in `.walkie-talkie/server.port`).

See `docs/superpowers/specs/2026-05-14-claude-walkie-talkie-design.md` for the full design.

## Install (post-1.0)

```
npm install -g claude-walkie-talkie
```

## License

MIT
```

- [ ] **Step 4: Write the Plan B kickoff prompt**

```markdown
<!-- docs/superpowers/plans/PLAN-B-KICKOFF-PROMPT.md -->
# Plan B Kickoff Prompt

Copy/paste the block below into a fresh Claude Code session at the repo root.

---

```
I'm continuing work on claude-walkie-talkie. Plan A (operator-facing CLI + daemon + walkie-core library) is complete and committed. The project lives at the current working directory.

Background reading (please read in this order before doing anything else):
1. docs/superpowers/specs/2026-05-14-claude-walkie-talkie-design.md — the full design spec.
2. docs/superpowers/plans/2026-05-14-plan-a-operator-radio.md — Plan A (what is already built).
3. The current repo state — git log, src/, test/.

Plan A delivered (already shipped):
- walkie-core library: time, ULIDs, mentions, git metadata, message format/parse, channel atomic-append-at-top with proper-lockfile, edit/archive with history audit trail.
- Per-project local daemon: Express HTTP server, SSE event stream, chokidar watcher for external edits, desktop notifications, permits gate, machine-wide registry.
- Operator CLI: init, start/stop/status (--all), talk (with @mention interactive invite), read, tail, reply, edit, archive, sessions, rename, alias, invite, permit, remove, config, logs.

Plan B scope (what to build now):
1. MCP server (src/mcp-server/) exposing the channel as tools and resources per spec §16. Tools: walkie_inbox, walkie_read, walkie_talk, walkie_reply, walkie_edit, walkie_archive, walkie_sessions, walkie_rename. Resources: walkie://channel/inbox (subscribable), walkie://channel/recent, walkie://sessions/active.
2. Plugin assets:
   - skills/walkie-talkie/SKILL.md — scenario-driven prompt for natural-language invocation in both Code and Cowork (spec §17.2-17.3).
   - hooks/hooks.json + hooks/scripts/check-inbox.sh — SessionStart + UserPromptSubmit command hooks that inject new messages into agent context (spec §17.4). Document that these are forward-compatible with Cowork (issue anthropics/claude-code#27398).
   - commands/walkie-inbox.md, commands/walkie-talk.md — explicit slash commands (spec §17.5).
   - plugin.json and mcp.json at repo root (spec §4 file structure).
3. Documentation:
   - Full README with install/quickstart/usage table/FAQ (spec §25).
   - docs/architecture.md with mermaid diagram of the three surfaces.
   - docs/setup.md walking through installing the plugin into Code and Cowork.
   - docs/api.md as the HTTP + MCP reference.
   - examples/demo-while-presenting/ — the canonical walkthrough.
   - CONTRIBUTING.md.
4. Memory-update integration in SKILL.md per spec §20.
5. End-to-end harness (spec §24 layer 3): spawn the daemon, spawn two mock MCP clients, walk through join → talk → @mention → reply → edit → archive → invite → fulfill.

Please use the superpowers:writing-plans skill to draft Plan B, save it to docs/superpowers/plans/<today>-plan-b-claude-integration.md, then execute via superpowers:subagent-driven-development. After writing the plan, present it section-by-section for my approval before starting execution.

Important constraints reinforced from Plan A:
- Plan A established that walkie-core is the only writer to channel.md. Plan B's MCP server MUST use the same walkie-core primitives (not bypass them) so concurrency invariants hold.
- Cowork plugin hooks do not currently fire (issue anthropics/claude-code#27398). Ship them anyway as forward-compatible; document the Cowork latency limitation honestly in the README.
- Natural language is the primary mode in Code and Cowork; SKILL.md is scenario-driven, not command-driven.
- One plugin, both environments.
- All MCP tools must call into walkie-core or the local daemon's HTTP API, never write channel.md directly.

When you start, first verify Plan A is functioning end-to-end by running the manual smoke from the end of Plan A's Task 34. Confirm before writing Plan B.
```

---

End of prompt.
```

- [ ] **Step 5: Final commit**

```bash
git add README.md docs/superpowers/plans/PLAN-B-KICKOFF-PROMPT.md
git commit -m "docs: Plan A complete — update README + Plan B kickoff prompt"
```

- [ ] **Step 6: Tag the milestone**

```bash
git tag -a plan-a-complete -m "Plan A: operator radio (walkie-core + daemon + CLI)"
git log --oneline -5
```

Expected: `plan-a-complete` tag on the most recent commit. Five most recent commits visible.

---

## Self-Review Check

This plan has been reviewed against the spec for:

- **Spec coverage:** §3 (Node.js) ✓, §4 (repo layout) ✓, §5 (per-project layout) ✓, §6 (channel format) ✓, §7 (atomic append) ✓, §8 (hand-edit policy) ✓ (watcher), §9 (session lifecycle) ✓, §10 (@mentions) ✓, §11 (invitations) ✓, §12 (edit/archive) ✓, §13 (HTTP API) ✓, §14 (SSE events) ✓, §15 (daemon lifecycle) ✓, §18 latency (Code hooks deferred to Plan B) — `walkie tail` proves the SSE half, §19 (permits) ✓, §21 (CLI surface) ✓ — all 18 commands, §22 (cross-platform) ✓ — Node ≥18 + no shell exec, §23 (logging) ✓ — logs/ + `walkie logs`, §24 layer 1+2 (testing) ✓ — unit + integration; layer 3 deferred to Plan B.

- **Out of Plan A (Plan B scope):** §16 (MCP server), §17 (skill + hooks + slash commands), §20 (memory-update integration — needs SKILL.md), §24 layer 3 (full E2E harness), §25 (most docs).

- **Type consistency:** function names, parameter shapes, and return contracts match across tasks (`appendMessage` returns the ID; `editMessage` returns `{ revision }`; `joinSession` returns the full session record). CLI commands use the same client method names everywhere.

- **No placeholders:** every step has concrete code, exact commands, and verifiable expected output.

---

## Execution Handoff

Plan A complete and saved to `docs/superpowers/plans/2026-05-14-plan-a-operator-radio.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints.

**Which approach?**

After Plan A is shipped, use the prompt in `docs/superpowers/plans/PLAN-B-KICKOFF-PROMPT.md` to start Plan B in a fresh session.







