-- Collabcast v0.3 canonical store schema. Version 4.
--
-- This file is the single source of truth for the SQLite shape. It is applied
-- once, idempotently, by src/store/db.js. Every credential, event, cursor,
-- lease, permit and audit row carries a `namespace` so one database file can
-- never leak authority across projects.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=FULL;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS principal (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('root','goal_hub','listener','operator','legacy')),
  display_alias TEXT,
  paseo_agent_id TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Alias uniqueness is scoped to live principals only: revoking a principal
-- frees its alias, but a collision with a live incumbent rejects the newcomer.
--
-- The collation is NOCASE because mention resolution folds case. Under the
-- default BINARY collation `alice` and `Alice` could both be live, and a
-- directed `@alice` then folded to two principals: v0.3 resolved that to
-- neither, so the incumbent went dark, and it resolved to the squatter as soon
-- as the incumbent was renamed or revoked. Uniqueness must be enforced on the
-- same fold the resolver uses, or the resolver has no unique answer to find.
CREATE UNIQUE INDEX IF NOT EXISTS principal_alias
  ON principal(namespace, display_alias COLLATE NOCASE) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS capability (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principal(id),
  token_sha256 BLOB NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  attestation_kind TEXT NOT NULL
    CHECK(attestation_kind IN ('omp_hook_confirm','operator_cli','delegation')),
  attestation_ref TEXT NOT NULL,
  parent_capability_id TEXT REFERENCES capability(id),
  renewed_from TEXT REFERENCES capability(id),
  revoked_at TEXT,
  revoked_reason TEXT
);

CREATE INDEX IF NOT EXISTS capability_principal ON capability(namespace, principal_id);
CREATE INDEX IF NOT EXISTS capability_parent ON capability(parent_capability_id);
CREATE INDEX IF NOT EXISTS capability_renewed_from ON capability(renewed_from);

CREATE TABLE IF NOT EXISTS approval (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('enrollment','prune','rollback','scope_widen')),
  subject_digest BLOB NOT NULL,
  requested_scopes TEXT,
  requested_ttl_s INTEGER,
  approved_at TEXT NOT NULL,
  approving_principal TEXT NOT NULL,
  attestation_kind TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT
);

CREATE TABLE IF NOT EXISTS enrollment_code (
  code_sha256 BLOB PRIMARY KEY,
  namespace TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approval(id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS enrollment_code_namespace
  ON enrollment_code(namespace, approval_id);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('message.posted','message.edited','message.archived','thread.resolved','thread.held','thread.unheld')),
  thread_id TEXT NOT NULL,
  target_event_id TEXT,
  author_principal_id TEXT NOT NULL REFERENCES principal(id),
  author_role TEXT NOT NULL,
  author_alias_at_write TEXT,
  msg_type TEXT NOT NULL CHECK(msg_type IN ('broadcast','question','reply','memory-update')),
  reply_to TEXT,
  mentions TEXT NOT NULL DEFAULT '[]',
  body TEXT,
  body_sha256 BLOB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  git_branch TEXT,
  git_hash TEXT,
  created_at TEXT NOT NULL,
  pruned_at TEXT
);

CREATE INDEX IF NOT EXISTS event_thread ON event(namespace, thread_id);

CREATE TABLE IF NOT EXISTS thread (
  thread_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved','held')),
  state_changed_at TEXT NOT NULL,
  state_changed_by TEXT REFERENCES principal(id)
);

-- A cursor position is the id of the last message the owner read/acked, never an
-- ordinal: an ordinal is recomputed from whatever currently parses, so losing one
-- message silently re-points every cursor past messages that were never delivered.
-- '' means "nothing yet" and sorts below every id under BINARY collation.
--
-- There is one cursor per (owner, kind, VIEW), and the view is baked into `kind`.
-- A single scalar high-water mark is only sound over a set that cannot gain members
-- BELOW the mark, and `GET /inbox` serves two differently-filtered sets: the default
-- one excludes `memory-update` messages, the `include_memory_updates=true` one does
-- not. One mark across both meant acking a later broadcast in the default view put
-- the mark above an undelivered memory-update, which then became permanently
-- unreachable in the inclusive view — non-delivery silently recorded as
-- acknowledgement. So: one mark per view, each sound over its own set.
--
-- `_with_memory` names the memory-INCLUSIVE view (every non-archived message), not a
-- memory-only stream. The two sets are nested, so a reader that acks in the inclusive
-- view has genuinely seen everything at or below that id in the default view too, and
-- `POST /cursor/*` advances both marks in that case. The converse is not true, which
-- is exactly why the default view cannot move the inclusive mark.
CREATE TABLE IF NOT EXISTS cursor (
  namespace TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('read','ack','read_with_memory','ack_with_memory')),
  last_message_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(namespace, owner_principal_id, kind)
);

CREATE TABLE IF NOT EXISTS lease (
  -- Explicitly NOT NULL: SQLite does not imply it for a non-INTEGER PRIMARY KEY in a
  -- rowid table, so `PRIMARY KEY` alone let a NULL namespace insert here while every
  -- other table refused one. Rebuilt by migrate4to5 rather than left to new files.
  namespace TEXT PRIMARY KEY NOT NULL,
  holder_principal_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoff (
  namespace TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  attempted_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  receipted_at TEXT,
  paseo_status TEXT,
  paseo_response TEXT,
  PRIMARY KEY(namespace, event_seq, target_id)
);

CREATE TABLE IF NOT EXISTS permit (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL
    CHECK(operation IN ('retention.prune','retention.rollback','capability.widen')),
  resource_id TEXT NOT NULL,
  content_digest BLOB NOT NULL,
  approval_id TEXT NOT NULL REFERENCES approval(id),
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'granted'
    CHECK(state IN ('granted','consumed','revoked','expired')),
  consumed_at TEXT,
  consumed_ref TEXT
);

CREATE INDEX IF NOT EXISTS permit_lookup ON permit(namespace, principal_id, state);

CREATE TABLE IF NOT EXISTS hold (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('thread','event')),
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
);

CREATE INDEX IF NOT EXISTS hold_subject ON hold(namespace, subject_kind, subject_id);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  at TEXT NOT NULL,
  actor_principal_id TEXT,
  action TEXT NOT NULL,
  subject TEXT,
  outcome TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS audit_at ON audit(namespace, at);
