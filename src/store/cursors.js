import { context } from './db.js';
import { fail } from './errors.js';
import { now } from './clock.js';
import { isId } from '../core/ids.js';

/**
 * Read and ack cursors.
 *
 * A cursor is (namespace, owner_principal_id, kind) -> the id of the last
 * message the owner read or acknowledged. It is owned by exactly one principal
 * and moves only forward.
 *
 * v0.2 had no cursor rows at all: `GET /sessions/:id/inbox` advanced a
 * registry-file "last read id" as a SIDE EFFECT OF READING, addressed by a
 * path parameter, with no authentication. Anyone could therefore (a) burn
 * another session's unread queue by reading it and (b) silently lose messages
 * whenever a read raced a write. Both properties are removed here: cursors are
 * data, they move only through an explicit write, and the owner is always the
 * authenticated principal — there is no parameter for whose cursor to move.
 *
 * A cursor is a MESSAGE ID, not an ordinal, and that distinction is the whole
 * point. It was briefly the 1-based ordinal of the message in `channel.md`,
 * recomputed on every read over the messages that happened to parse. That made
 * every stored cursor a function of the whole file: corrupt one older message's
 * marker, hand-edit one `## ` heading, or prune one message for retention, and
 * every ordinal after it shifted down by one — silently re-pointing every
 * reader's cursor PAST messages it had never been shown. No error, no audit
 * row, and the skipped message was gone for good. Ids do not have that
 * property: an id is minted once and compares the same way forever, whatever
 * else happens to the file (`src/core/ids.js` states why a plain string
 * comparison is the right one). "Nothing yet" is `NO_CURSOR`, which sorts below
 * every id.
 *
 * The store still never interprets a cursor beyond "larger is later".
 *
 * ## One mark per VIEW
 *
 * A scalar high-water mark is sound only over a set that cannot gain members BELOW the
 * mark. `GET /inbox` serves two differently-filtered sets — the default one excludes
 * `memory-update` messages, `?include_memory_updates=true` does not — so one mark across
 * both was unsound in a way that lost messages: a reader shown [broadcast1, broadcast3]
 * and acking `broadcast3` (exactly what the ack contract asks for: "the id of the last
 * message you actually processed") put the mark above `memory-update2`, which it was
 * never shown, making it permanently unreachable in the inclusive view. Non-delivery
 * recorded as acknowledgement.
 *
 * So each view carries its own kind. `_with_memory` names the memory-INCLUSIVE view —
 * every non-archived message — not a memory-only stream. The sets are nested, so acking
 * in the inclusive view is evidence for both marks and `POST /cursor/*` advances both;
 * acking in the default view is evidence for the default mark only. The asymmetry is the
 * whole point, not an oversight.
 */

/** The default view: every non-archived message except `memory-update`. */
export const VIEW_DEFAULT = Object.freeze({ read: 'read', ack: 'ack' });

/** The `?include_memory_updates=true` view: every non-archived message. */
export const VIEW_WITH_MEMORY = Object.freeze({
  read: 'read_with_memory',
  ack: 'ack_with_memory'
});

export const CURSOR_KINDS = Object.freeze([
  VIEW_DEFAULT.read,
  VIEW_DEFAULT.ack,
  VIEW_WITH_MEMORY.read,
  VIEW_WITH_MEMORY.ack
]);
const KIND_SET = new Set(CURSOR_KINDS);

/**
 * The kinds belonging to one `/inbox` view.
 *
 * @param {boolean} includeMemoryUpdates
 * @returns {{read:string, ack:string}}
 */
export function cursorView(includeMemoryUpdates) {
  return includeMemoryUpdates === true ? VIEW_WITH_MEMORY : VIEW_DEFAULT;
}

/**
 * The kinds a write against `view` must advance.
 *
 * Acking in the memory-inclusive view means the reader saw every non-archived message at
 * or below that id, which includes every message the default view would have shown — so
 * both marks move. Acking in the default view is no evidence at all about the
 * memory-updates it hid, so only the default mark moves.
 *
 * @param {boolean} includeMemoryUpdates
 * @param {'read'|'ack'} kind
 * @returns {string[]}
 */
export function cursorKindsToAdvance(includeMemoryUpdates, kind) {
  return includeMemoryUpdates === true
    ? [VIEW_DEFAULT[kind], VIEW_WITH_MEMORY[kind]]
    : [VIEW_DEFAULT[kind]];
}

/**
 * The position of a principal that has never read or acked anything. The empty
 * string, not null: it is a real value the comparison in `advanceCursor` and the
 * filter in `GET /inbox` can both use directly, and it is below every id.
 */
export const NO_CURSOR = '';

function requireKind(kind) {
  if (!KIND_SET.has(kind)) fail('invalid_request', 'unknown cursor kind', { kind: String(kind) });
  return kind;
}

function requirePrincipalId(id) {
  if (typeof id !== 'string' || id.length === 0) {
    fail('invalid_request', 'ownerPrincipalId is required');
  }
  return id;
}

/**
 * A cursor may only ever be set to a message id. `NO_CURSOR` is a readable
 * position, never a writable one: there is no way to express a rewind.
 *
 * @param {unknown} messageId
 * @returns {string}
 */
export function requireMessageId(messageId) {
  if (!isId(messageId)) {
    fail('invalid_request', 'messageId must be a message id (26-character uppercase ULID)');
  }
  return messageId;
}

/**
 * The principal's current position, or `NO_CURSOR` when it has never read/acked.
 *
 * @param {object} store
 * @param {string} ownerPrincipalId
 * @param {string} kind 'read' | 'ack'
 * @returns {string}
 */
export function getCursor(store, ownerPrincipalId, kind) {
  const ctx = context(store);
  requireKind(kind);
  requirePrincipalId(ownerPrincipalId);
  const row = ctx.db
    .prepare(
      'SELECT last_message_id FROM cursor WHERE namespace = ? AND owner_principal_id = ? ' +
        'AND kind = ?'
    )
    .get(ctx.namespace, ownerPrincipalId, kind);
  return row ? String(row.last_message_id) : NO_CURSOR;
}

/**
 * Every cursor the principal owns, split by view.
 *
 * One SELECT, both views, because `GET /inbox` reports both marks: a client that acked
 * in one view needs to see where the other one stands, otherwise the asymmetry above is
 * invisible from the outside and looks like a lost message.
 *
 * @param {object} store
 * @param {string} ownerPrincipalId
 * @returns {{default:{read:string, ack:string}, withMemoryUpdates:{read:string, ack:string}}}
 */
export function getCursorViews(store, ownerPrincipalId) {
  const ctx = context(store);
  requirePrincipalId(ownerPrincipalId);
  const rows = ctx.db
    .prepare(
      'SELECT kind, last_message_id FROM cursor WHERE namespace = ? AND owner_principal_id = ?'
    )
    .all(ctx.namespace, ownerPrincipalId);
  const byKind = new Map(rows.map((row) => [row.kind, String(row.last_message_id)]));
  const project = (view) => ({
    read: byKind.get(view.read) ?? NO_CURSOR,
    ack: byKind.get(view.ack) ?? NO_CURSOR
  });
  return { default: project(VIEW_DEFAULT), withMemoryUpdates: project(VIEW_WITH_MEMORY) };
}

/**
 * One view's two cursors in one read. Defaults to the default view, so a caller that
 * does not know views exist gets the marks governing the default `/inbox`.
 *
 * @param {object} store
 * @param {string} ownerPrincipalId
 * @param {{includeMemoryUpdates?:boolean}} [opts]
 * @returns {{read:string, ack:string}}
 */
export function getCursors(store, ownerPrincipalId, { includeMemoryUpdates = false } = {}) {
  const views = getCursorViews(store, ownerPrincipalId);
  return includeMemoryUpdates === true ? views.withMemoryUpdates : views.default;
}

/**
 * Advances a cursor. Monotonic by construction: the UPDATE carries
 * `WHERE last_message_id < :messageId`, so a lower or equal id changes nothing
 * and the current value is returned. Rewinding is not an error and not a
 * capability — there is no way to express it.
 *
 * The comparison is SQLite's default BINARY collation over two TEXT values of
 * equal length, which for the ULID alphabet is the same order as minting time.
 *
 * @param {object} store
 * @param {{ownerPrincipalId:string, kind:string, messageId:string}} opts
 * @returns {{messageId:string, advanced:boolean}}
 */
export function advanceCursor(store, opts = {}) {
  const ctx = context(store);
  const kind = requireKind(opts.kind);
  const owner = requirePrincipalId(opts.ownerPrincipalId);
  const messageId = requireMessageId(opts.messageId);
  const at = now();

  // INSERT ... ON CONFLICT keeps the whole thing one statement, so two racing
  // writers cannot interleave a read-then-write and lose the higher value.
  const res = ctx.db
    .prepare(
      'INSERT INTO cursor (namespace, owner_principal_id, kind, last_message_id, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(namespace, owner_principal_id, kind) DO UPDATE SET ' +
        'last_message_id = excluded.last_message_id, updated_at = excluded.updated_at ' +
        'WHERE cursor.last_message_id < excluded.last_message_id'
    )
    .run(ctx.namespace, owner, kind, messageId, at);

  return { messageId: getCursor(ctx, owner, kind), advanced: res.changes === 1 };
}
