/**
 * The MCP tool surface.
 *
 * The eight original `walkie_*` names, their input schemas and their response shapes are a
 * compatibility surface and are preserved. What changed is underneath: not one handler declares
 * who it is any more. Author, alias, tool, timestamp, git metadata and mentions are derived by
 * the service from the bearer token, so `fromSessionId`, `fromAlias`, `fromTool`,
 * `autonomous`, `editedBy` and `archivedBy` are gone from every request body. A handler that
 * sent them would be trying to author its own authority.
 *
 * Two additions:
 *
 * - `walkie_enroll` — the bootstrap. The operator-approval hook injects a one-use enrollment
 *   code into this call's arguments; the handler redeems it and keeps the resulting token in
 *   memory. The token is never returned to the model, never written down and never logged.
 * - `walkie_ack` — acknowledgement, which used to be a side effect of reading. See ACK_NOTE.
 *
 * Every failure comes back as a structured, human-readable JSON payload carrying the error
 * code, so a model can branch on `not_owner` or `conflict` rather than pattern-matching an
 * HTTP status string.
 */

import { isWalkieError, walkieError } from '../identity/errors.js';
import { isId } from '../core/ids.js';
import { ENROLLMENT_CODE_RE } from './capability.js';

/**
 * Why acknowledgement is its own tool rather than an `ack_through_id` parameter on
 * `walkie_inbox`:
 *
 * 1. A parameter on the read call rebuilds the coupling this wave exists to remove. Reading
 *    and acknowledging would travel together again, and a model that habitually passes the
 *    parameter has re-created consume-on-read by convention instead of by code.
 * 2. They are different authorities. `GET /inbox` needs `channel:read`; `POST /cursor/ack`
 *    needs `channel:ack` and `POST /cursor/read` needs `self:cursor`. Folding them into one
 *    tool means a listener holding only `channel:read` gets a partial failure out of a call it
 *    thought was a read.
 * 3. `walkie_inbox`'s schema stays byte-identical to v0.2. Its response no longer carries a
 *    `seq` per message: the cursor is a message id, so `id` is the value you ack with.
 */
export const ACK_NOTE = 'acknowledgement is the separate walkie_ack tool, never a side effect of reading';

/**
 * Authority fields a client is no longer allowed to state. Rejected at the tool boundary so a
 * confused model gets an explanation instead of a bare 400 from the service.
 */
export const LEGACY_AUTHORITY_KEYS = Object.freeze([
  'fromSessionId',
  'fromAlias',
  'fromTool',
  'autonomous',
  'editedBy',
  'archivedBy',
  'sessionId',
  'invitedBy',
  'operator'
]);

const MESSAGE_TYPES = Object.freeze(['broadcast', 'question', 'reply', 'memory-update']);

const SCHEMAS = {
  walkie_inbox: {
    description:
      'New messages since this session last read. Mentioned-for-me messages are flagged. ' +
      'Memory updates excluded by default. Reading never acknowledges anything: use ' +
      'walkie_ack to advance your cursors. The two views have SEPARATE cursors, so pass ' +
      'the same include_memory_updates value to walkie_ack that you passed here.',
    inputSchema: {
      type: 'object',
      properties: {
        include_memory_updates: {
          type: 'boolean',
          default: false,
          description:
            'Include memory-update messages. This is a different view with its own ' +
            'cursor, not an extra filter on the default one.'
        }
      },
      additionalProperties: false
    }
  },
  walkie_ack: {
    description:
      'Acknowledge channel messages through a message id, and by default advance your ' +
      'read cursor to the same point. Cursors only move forward. Take the id of the last ' +
      'message you actually processed from walkie_inbox, and pass the same ' +
      'include_memory_updates value you called walkie_inbox with — each view has its own ' +
      'cursor, so acking the wrong one leaves what you read unacknowledged.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
        mark_read: {
          type: 'boolean',
          default: true,
          description: 'Also advance the read cursor. Needs the self:cursor scope.'
        },
        include_memory_updates: {
          type: 'boolean',
          default: false,
          description:
            'Acknowledge the memory-inclusive view. True also advances the default ' +
            'view (you saw a superset); false leaves the memory-inclusive view alone, ' +
            'because the default view hid those messages from you.'
        }
      },
      additionalProperties: false
    }
  },
  walkie_read: {
    description: 'Latest N messages from the channel, newest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 5, minimum: 1, maximum: 200 },
        include_archived: { type: 'boolean', default: false }
      },
      additionalProperties: false
    }
  },
  walkie_talk: {
    description:
      'Post a message on the channel. Your identity is taken from this session\'s capability; ' +
      'you do not state it. Use @<alias> mentions in the body to direct attention; @operator ' +
      'and @all also work.',
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string' },
        type: { type: 'string', enum: [...MESSAGE_TYPES], default: 'broadcast' },
        reply_to: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  walkie_reply: {
    description:
      'Reply to a specific message. Convenience wrapper around walkie_talk that prefills ' +
      'reply_to and type="reply".',
    inputSchema: {
      type: 'object',
      required: ['reply_to', 'body'],
      properties: {
        reply_to: { type: 'string' },
        body: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  walkie_edit: {
    description:
      'Edit a message you authored. Bumps the revision and preserves the prior body in ' +
      'history. Only the author may edit a body.',
    inputSchema: {
      type: 'object',
      required: ['id', 'body'],
      properties: {
        id: { type: 'string' },
        body: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  walkie_archive: {
    description: 'Archive a message so it is hidden from default reads. Archives are never deleted.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  walkie_sessions: {
    description:
      'Who is on the channel: every principal with its role and display alias, so you know ' +
      'valid @mention targets.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  walkie_rename: {
    description:
      "Change THIS principal's display alias. An alias already in use is refused; the " +
      'principal holding it is never renamed.',
    inputSchema: {
      type: 'object',
      required: ['alias'],
      properties: { alias: { type: 'string' } },
      additionalProperties: false
    }
  },
  walkie_enroll: {
    description:
      'Request a walkie capability for this session. The operator must approve: the approval ' +
      'hook injects a one-use enrollment code into this call, which is redeemed for a ' +
      'capability held in memory for the life of this process. You never author or see that ' +
      'code, and no token is ever returned to you. Supply the namespace, role and scopes you ' +
      'are asking for so the operator can see what they are approving.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'The channel namespace you are joining.' },
        role: { type: 'string', description: 'The role being requested, e.g. listener.' },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'The scopes being requested, e.g. ["channel:read","channel:publish"].'
        },
        ttlSeconds: { type: 'number', minimum: 1 }
      },
      // `enrollmentCode` is deliberately absent: it is not a model input.
      additionalProperties: false
    }
  }
};

/** Extra guidance attached to a structured failure, keyed by error code. */
const HINTS = Object.freeze({
  unauthenticated: 'call walkie_enroll and have the operator approve the request',
  not_owner: 'only the principal that authored a message may change its body',
  conflict: 'pick a different value; the existing holder is never displaced',
  scope_required: 'this session\'s capability was not granted that scope; a new one must be issued',
  wrong_namespace: 'this capability belongs to a different channel namespace',
  permit_invalid: 'ask the operator to approve enrollment again; a code cannot be reused',
  unavailable: 'the walkie service is not reachable; this client will not start one',
  invalid_request: 'fix the arguments and call again'
});

function text(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function failure(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
}

/**
 * The one structured error shape every tool returns. Never contains a raw HTTP string, a
 * token, or an unexpected exception's message.
 *
 * @param {string} tool
 * @param {unknown} err
 * @param {string} [hint] tool-specific guidance that beats the code's generic hint
 */
function errorResult(tool, err, hint) {
  if (!isWalkieError(err)) {
    return failure({
      status: 'error',
      tool,
      code: 'internal',
      message: `${tool} failed unexpectedly`
    });
  }
  const payload = { status: 'error', tool, code: err.code, message: err.message };
  if (err.detail !== undefined) payload.detail = err.detail;
  const guidance = hint ?? HINTS[err.code];
  if (guidance) payload.hint = guidance;
  return failure(payload);
}

/**
 * The single `permit_required` payload builder. v0.2 hand-picked four fields in walkie_talk and
 * spread the whole body in walkie_reply, so the same condition produced two different shapes;
 * both callers now go through here, so the shapes are identical by construction.
 *
 * @param {import('../identity/errors.js').WalkieError} err
 */
function permitRequiredResult(err) {
  return text({
    status: 'permit_required',
    code: 'permit_required',
    message: err.message,
    detail: err.detail ?? null
  });
}

function requireString(args, key, tool) {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw walkieError('invalid_request', `${tool} requires a non-empty ${key}`);
  }
  return value;
}

function requireMessageId(args, tool) {
  if (!isId(args.id)) {
    throw walkieError('invalid_request', `${tool} requires id to be a message id`);
  }
  return args.id;
}

/** Reject a caller trying to state its own authority. */
function rejectLegacyKeys(args, tool) {
  const offending = LEGACY_AUTHORITY_KEYS.filter((key) => args[key] !== undefined);
  if (offending.length === 0) return;
  throw walkieError(
    'invalid_request',
    `${tool} does not accept ${offending.join(', ')}: your identity is derived from this ` +
      'session\'s capability, not from arguments',
    { rejected: offending }
  );
}

/**
 * @param {object} deps
 * @param {object} deps.api
 * @param {ReturnType<import('./capability.js').createCapabilityHolder>} deps.capability
 * @param {string} deps.namespace
 */
export function buildTools({ api, capability, namespace } = {}) {
  function list() {
    return Object.entries(SCHEMAS).map(([name, schema]) => ({ name, ...schema }));
  }

  async function enroll(args) {
    const code = args.enrollmentCode;
    if (code === undefined) {
      throw walkieError(
        'permit_required',
        'no enrollment code was injected into this call, so no operator approved it. ' +
          'Enrollment requires the walkie approval hook to be installed in an interactive ' +
          'session; a non-interactive session must be given a delegated capability instead.'
      );
    }
    if (typeof code !== 'string' || !ENROLLMENT_CODE_RE.test(code)) {
      // A code the model authored itself cannot have this shape, and must never be forwarded:
      // only the approval hook may supply one.
      throw walkieError(
        'invalid_request',
        'the enrollment code on this call is not one the operator approval hook issued. ' +
          'A model must not supply enrollmentCode: it is injected, never authored.'
      );
    }
    const issued = await api.enrollExchange(code);
    const identity = await capability.adopt(issued.token, {
      capabilityId: issued.capabilityId,
      principalId: issued.principalId,
      role: issued.role,
      scopes: issued.scopes,
      expiresAt: issued.expiresAt
    });
    // Deliberately no token, and no capabilityId either: neither is the model's business.
    return text({
      status: 'enrolled',
      role: identity.role,
      scopes: identity.scopes,
      expiresAt: identity.expiresAt
    });
  }

  async function call(request) {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      if (name === 'walkie_enroll') return await enroll(args);

      rejectLegacyKeys(args, name);
      capability.requireActive();

      switch (name) {
        case 'walkie_inbox': {
          // GET only. Reading does not move a cursor.
          return text(
            await api.inbox({ includeMemoryUpdates: args.include_memory_updates === true })
          );
        }
        case 'walkie_ack': {
          const id = requireMessageId(args, name);
          // The same flag `walkie_inbox` took: each view has its own cursor pair, and
          // acking the wrong one leaves what was actually read unacknowledged.
          const view = { includeMemoryUpdates: args.include_memory_updates === true };
          const markRead = args.mark_read !== false;
          // Acknowledgement FIRST. Two calls means the second one can fail, and these two
          // are not equally important: a lost read-cursor move costs a re-read, a lost ack
          // makes the caller replay messages it has already handled. The old order put the
          // cheap one first and then surfaced a thrown ack as a flat error, so a partial
          // apply — read cursor moved, ack not — was indistinguishable from a no-op.
          const result = { status: 'acknowledged', lastAckedId: (await api.ack(id, view)).id };
          if (markRead) {
            try {
              result.lastReadId = (await api.markRead(id, view)).id;
            } catch (err) {
              // Report what landed rather than throwing away a committed ack. The model
              // needs to know the ack is done so it does not replay, and that the read
              // cursor is behind so it can retry just that.
              //
              // A non-walkie throw's message is untrusted text — a driver error carries
              // socket paths and internals — so only a WalkieError's message crosses the
              // boundary. Same rule `errorResult` enforces for every other tool; this
              // branch is new and would otherwise have been the one hole in it.
              result.status = 'partially_acknowledged';
              result.markRead = {
                applied: false,
                code: isWalkieError(err) ? err.code : 'internal',
                message: isWalkieError(err) ? err.message : 'the read cursor could not be moved'
              };
            }
          }
          return text(result);
        }
        case 'walkie_read': {
          return text(await api.latest(args.limit ?? 5, args.include_archived === true));
        }
        case 'walkie_talk': {
          const body = requireString(args, 'body', name);
          try {
            return text(
              await api.post({ body, type: args.type ?? 'broadcast', replyTo: args.reply_to })
            );
          } catch (err) {
            if (err?.code === 'permit_required') return permitRequiredResult(err);
            throw err;
          }
        }
        case 'walkie_reply': {
          const replyTo = requireString(args, 'reply_to', name);
          const body = requireString(args, 'body', name);
          try {
            return text(await api.post({ body, type: 'reply', replyTo }));
          } catch (err) {
            if (err?.code === 'permit_required') return permitRequiredResult(err);
            throw err;
          }
        }
        case 'walkie_edit': {
          const id = requireString(args, 'id', name);
          const body = requireString(args, 'body', name);
          try {
            return text(await api.edit(id, { body }));
          } catch (err) {
            if (err?.code === 'not_owner') {
              return errorResult(
                name,
                err,
                'you did not author that message, so you cannot edit it; reply to it instead'
              );
            }
            throw err;
          }
        }
        case 'walkie_archive': {
          const id = requireString(args, 'id', name);
          try {
            return text(await api.archive(id, { reason: args.reason ?? null }));
          } catch (err) {
            if (err?.code === 'not_owner') {
              return errorResult(
                name,
                err,
                'only the message author, or an operator moderating the channel, may archive it'
              );
            }
            throw err;
          }
        }
        case 'walkie_sessions': {
          return text(await api.principals());
        }
        case 'walkie_rename': {
          const alias = requireString(args, 'alias', name);
          try {
            const result = await api.setAlias(alias);
            capability.setDisplayAlias(result.displayAlias);
            return text(result);
          } catch (err) {
            if (err?.code === 'conflict') {
              return errorResult(
                name,
                err,
                `the alias "${alias}" already belongs to another principal on this channel and ` +
                  'it will not be taken from them; choose a different alias'
              );
            }
            throw err;
          }
        }
        default:
          return errorResult(
            name,
            walkieError('not_found', `there is no walkie tool named ${name}`, { namespace })
          );
      }
    } catch (err) {
      return errorResult(name, err);
    }
  }

  return { list, call };
}
