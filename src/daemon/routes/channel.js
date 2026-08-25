import { Router } from 'express';
import { dirname, join } from 'node:path';
import {
  readChannel,
  appendMessage,
  editMessage,
  archiveMessage
} from '../../core/channel.js';
import { gitMetadata } from '../../core/git.js';
import { readHistory } from '../../core/history.js';
import { now } from '../../core/time.js';
import { walkieError } from '../../identity/errors.js';
import { audit } from '../../store/audit.js';
import { requireScope } from '../auth.js';
import {
  handler,
  ownsMessage,
  principalIdentity,
  readBody,
  readFlag,
  readLimit,
  resolveRosterMentions
} from './support.js';
import {
  MAX_BODY_LENGTH,
  isValidArchiveReason,
  isValidMessageBody,
  isValidMessageType,
  isValidReplyTo,
  isValidUlid
} from '../../core/validate.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

/** Every field a client may send on a write. Authority fields are not among them. */
const POST_FIELDS = ['body', 'type', 'replyTo'];
const PATCH_FIELDS = ['body'];
const ARCHIVE_FIELDS = ['reason'];

function requireId(value) {
  if (!isValidUlid(value)) {
    throw walkieError('invalid_request', 'message id must be a ULID');
  }
  return value;
}

/**
 * Body validation is applied on EVERY write path.
 *
 * v0.2's PATCH route never called `isValidMessageBody`, so an edit could write a
 * literal `<!-- walkie:msg ... -->` into the file and forge a second message
 * block — attributed to whoever the forged marker named. Posting and editing now
 * share exactly this check.
 */
function requireBody(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw walkieError('invalid_request', 'body is required');
  }
  // Length and markup are separate refusals. `isValidMessageBody` folds both
  // into one boolean, so reporting it as a single reason told an oversized but
  // otherwise clean body that it contained a control comment.
  if (value.length > MAX_BODY_LENGTH) {
    throw walkieError('invalid_request', `body exceeds the ${MAX_BODY_LENGTH} character limit`, {
      length: value.length,
      limit: MAX_BODY_LENGTH
    });
  }
  if (!isValidMessageBody(value)) {
    throw walkieError(
      'invalid_request',
      'body may not contain a walkie control comment or a markdown heading'
    );
  }
  return value;
}

function findMessage(messages, id) {
  const message = messages.find((m) => m.id === id);
  if (!message) throw walkieError('not_found', 'message not found', { id });
  return message;
}

/**
 * @param {{store:object, namespace:string, channelPath:string, events?:object}} deps
 */
export function channelRoutes({ store, namespace, channelPath, events } = {}) {
  if (!store) throw new Error('channelRoutes requires a store');
  if (!channelPath) throw new Error('channelRoutes requires a channelPath');
  const router = Router();
  const wtDir = dirname(channelPath);
  const sessionsDir = join(wtDir, '.sessions');
  // `.walkie-talkie` sits directly inside the project root; git metadata is read
  // from there, never from anything a caller supplies.
  const projectRoot = dirname(wtDir);

  // Prefer the injected emitter, but fall back to the server's own. Holding a
  // different emitter from the one `/events` subscribes to is a silent no-op:
  // publishes would emit into a void and no subscriber would ever see them.
  const emit = (req, event, payload) => {
    const emitter = events || req.app.locals.events;
    if (emitter) emitter.emit(event, payload);
  };

  /**
   * Appends one audit row for a channel decision.
   *
   * What this CANNOT do, stated plainly rather than papered over: the mutation
   * these rows describe is a write to `channel.md` through `src/core/channel.js`,
   * not a SQL statement. A file rename cannot join a SQLite transaction, so
   * unlike every other mutating route on this surface (`/capability/:id`,
   * `/self/alias`, `/cursor/*`, `/delegate`) the effect and its audit row here
   * are two commits in two different media, and no `store.tx` wrapper would
   * change that — it would only make the code look atomic.
   *
   * What IS guaranteed:
   *   - Ordering. The file write happens first, so an audit row never claims an
   *     append, edit or archive that did not take effect. The failure mode is a
   *     missing row, never a fabricated one.
   *   - Refusals are exact. A `denied` row is written where nothing was mutated,
   *     so if that INSERT fails the request 500s having changed nothing.
   *
   * The residual window: a crash — or an audit INSERT that throws — between the
   * committed file write and this row leaves a real channel mutation unrecorded,
   * and the client is told 500 about a write that happened. Closing it needs a
   * durable intent row written BEFORE the file write and settled after (an
   * outbox), which is a P1 change to `src/core/channel.js`, not to this route.
   */
  const record = (req, action, subject, outcome, detail) =>
    audit(store, {
      namespace,
      actorPrincipalId: req.walkie.principal.id,
      action,
      subject,
      outcome,
      detail
    });

  router.get(
    '/channel/latest',
    requireScope('channel:read'),
    handler(async (req, res) => {
      const limit = readLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
      const includeArchived = readFlag(req.query.include_archived);
      const { messages } = await readChannel(channelPath);
      const visible = includeArchived ? messages : messages.filter((m) => !m.archived);
      res.json({ messages: visible.slice(0, limit) });
    })
  );

  router.get(
    '/channel/since/:ulid',
    requireScope('channel:read'),
    handler(async (req, res) => {
      const after = requireId(req.params.ulid);
      const includeArchived = readFlag(req.query.include_archived);
      const { messages } = await readChannel(channelPath);
      const visible = messages.filter((m) => m.id > after && (includeArchived || !m.archived));
      res.json({ messages: visible });
    })
  );

  router.get(
    '/channel/message/:id',
    requireScope('channel:read'),
    handler(async (req, res) => {
      const id = requireId(req.params.id);
      const { messages } = await readChannel(channelPath);
      const message = findMessage(messages, id);
      const history = await readHistory(sessionsDir, id);
      res.json({ message, history });
    })
  );

  router.post(
    '/channel/message',
    requireScope('channel:publish'),
    handler(async (req, res) => {
      const principal = req.walkie.principal;
      const fields = readBody(req.body, POST_FIELDS);
      const body = requireBody(fields.body);
      const type = fields.type === undefined ? 'broadcast' : fields.type;
      if (!isValidMessageType(type)) {
        throw walkieError('invalid_request', 'unknown message type', { type: String(type) });
      }
      const replyTo = fields.replyTo === undefined ? null : fields.replyTo;
      if (!isValidReplyTo(replyTo)) {
        throw walkieError('invalid_request', 'replyTo must be a ULID');
      }

      const { mentions, unresolved } = resolveRosterMentions(store, body);
      const id = await appendMessage(channelPath, {
        type,
        ...principalIdentity(principal),
        mentions,
        mentionsPending: unresolved,
        replyTo,
        timestamp: now(),
        git: gitMetadata(projectRoot),
        body
      });

      record(req, 'channel.publish', id, 'allowed', { type, mentions, unresolved });
      // `role` travels with the event because a consumer deciding whether to
      // notify needs to know the author's role: `from` is a principal id, so a
      // subscriber comparing it against 'operator' never matches and the
      // operator gets notified about their own post. Roles are already visible
      // to any `channel:read` holder through GET /principals, and /events is
      // gated on exactly that scope, so this discloses nothing new.
      emit(req, 'message.posted', { id, type, from: principal.id, role: principal.role, mentions });
      res.status(201).json({
        id,
        warnings: unresolved.map((token) => ({ type: 'unresolved-mention', token }))
      });
    })
  );

  router.patch(
    '/channel/message/:id',
    requireScope('channel:publish'),
    handler(async (req, res) => {
      const principal = req.walkie.principal;
      const id = requireId(req.params.id);
      const body = requireBody(readBody(req.body, PATCH_FIELDS).body);

      const { messages } = await readChannel(channelPath);
      const message = findMessage(messages, id);
      // Editing is authorship, not moderation: there is deliberately no operator
      // override here. An operator can archive a message it did not write, but no
      // principal — operator included — can rewrite another's body.
      if (!ownsMessage(principal, message)) {
        record(req, 'channel.edit', id, 'denied', { reason: 'not_owner' });
        throw walkieError('not_owner', 'only the author may edit a message', { id });
      }

      const { revision } = await editMessage(channelPath, id, body, principal.id);
      record(req, 'channel.edit', id, 'allowed', { revision });
      emit(req, 'message.edited', { id, revision, by: principal.id });
      res.json({ id, revision });
    })
  );

  router.post(
    '/channel/message/:id/archive',
    requireScope('channel:publish'),
    handler(async (req, res) => {
      const principal = req.walkie.principal;
      const id = requireId(req.params.id);
      const fields = readBody(req.body, ARCHIVE_FIELDS);
      const reason = fields.reason === undefined ? null : fields.reason;
      if (!isValidArchiveReason(reason)) {
        throw walkieError(
          'invalid_request',
          'archive reason may not contain a quote, a comment terminator or a heading'
        );
      }

      const { messages } = await readChannel(channelPath);
      const message = findMessage(messages, id);
      const owned = ownsMessage(principal, message);
      const isOperator = principal.role === 'operator';
      if (!owned && !isOperator) {
        record(req, 'channel.archive', id, 'denied', { reason: 'not_owner' });
        throw walkieError('not_owner', 'only the author or an operator may archive a message', {
          id
        });
      }

      await archiveMessage(channelPath, id, principal.id, reason);
      record(req, 'channel.archive', id, 'allowed', { moderated: !owned });
      emit(req, 'message.archived', { id, by: principal.id });
      res.json({ ok: true });
    })
  );

  return router;
}
