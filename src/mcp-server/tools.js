const SCHEMAS = {
  walkie_inbox: {
    description: 'New messages since this session last read. Mentioned-for-me messages are flagged. Memory updates excluded by default.',
    inputSchema: {
      type: 'object',
      properties: {
        include_memory_updates: { type: 'boolean', default: false }
      }
    }
  },
  walkie_read: {
    description: 'Latest N messages from the channel, newest-first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', default: 5, minimum: 1, maximum: 200 },
        include_archived: { type: 'boolean', default: false }
      }
    }
  },
  walkie_talk: {
    description: 'Post a message on the channel. Agent posts are autonomous and require an operator permit. Use @<alias> mentions in the body to direct attention; @operator, @all, and @<tool> also work.',
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string' },
        type: { type: 'string', enum: ['broadcast', 'question', 'reply', 'memory-update'], default: 'broadcast' },
        reply_to: { type: 'string' }
      }
    }
  },
  walkie_reply: {
    description: 'Reply to a specific message. Convenience wrapper around walkie_talk that prefills reply_to and type="reply".',
    inputSchema: {
      type: 'object',
      required: ['reply_to', 'body'],
      properties: {
        reply_to: { type: 'string' },
        body: { type: 'string' }
      }
    }
  },
  walkie_edit: {
    description: 'Edit a message you authored. Bumps the revision and preserves the prior body in history.',
    inputSchema: {
      type: 'object',
      required: ['id', 'body'],
      properties: {
        id: { type: 'string' },
        body: { type: 'string' }
      }
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
      }
    }
  },
  walkie_sessions: {
    description: 'List active sessions (so you know valid @mention targets) and pending invitations.',
    inputSchema: { type: 'object', properties: {} }
  },
  walkie_rename: {
    description: "Change THIS session's alias. If the new alias matches a pending invitation, the invitation is fulfilled.",
    inputSchema: {
      type: 'object',
      required: ['alias'],
      properties: { alias: { type: 'string' } }
    }
  }
};

function text(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function error(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function buildTools({ client, session } = {}) {
  function list() {
    return Object.entries(SCHEMAS).map(([name, schema]) => ({ name, ...schema }));
  }

  async function call(request) {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      switch (name) {
        case 'walkie_inbox': {
          const res = await client.inbox(session.sessionId, { includeMemoryUpdates: args.include_memory_updates === true });
          return text(res);
        }
        case 'walkie_read': {
          const limit = args.limit ?? 5;
          const includeArchived = args.include_archived === true;
          const res = await client.latest(limit, includeArchived);
          return text(res);
        }
        case 'walkie_talk': {
          if (!args.body) return error('body is required');
          try {
            const res = await client.post({
              body: args.body,
              type: args.type ?? 'broadcast',
              replyTo: args.reply_to,
              fromSessionId: session.sessionId,
              fromAlias: session.alias,
              fromTool: session.tool,
              autonomous: true
            });
            return text(res);
          } catch (e) {
            if (e.status === 403 && e.body?.status === 'permit_required') {
              return text({
                status: 'permit_required',
                session_id: e.body.session_id,
                reason: e.body.reason,
                hint: e.body.hint
              });
            }
            throw e;
          }
        }
        case 'walkie_reply': {
          if (!args.reply_to || !args.body) return error('reply_to and body are required');
          try {
            const res = await client.post({
              body: args.body,
              type: 'reply',
              replyTo: args.reply_to,
              fromSessionId: session.sessionId,
              fromAlias: session.alias,
              fromTool: session.tool,
              autonomous: true
            });
            return text(res);
          } catch (e) {
            if (e.status === 403 && e.body?.status === 'permit_required') {
              return text({ status: 'permit_required', ...e.body });
            }
            throw e;
          }
        }
        case 'walkie_edit': {
          if (!args.id || !args.body) return error('id and body are required');
          const res = await client.edit(args.id, { body: args.body, editedBy: session.sessionId });
          return text(res);
        }
        case 'walkie_archive': {
          if (!args.id) return error('id is required');
          const res = await client.archive(args.id, { archivedBy: session.sessionId, reason: args.reason ?? null });
          return text(res);
        }
        case 'walkie_sessions': {
          const res = await client.sessions();
          return text(res);
        }
        case 'walkie_rename': {
          if (!args.alias) return error('alias is required');
          const res = await client.rename(session.sessionId, args.alias);
          session.alias = args.alias;
          return text(res);
        }
        default:
          return error(`tool ${name} not implemented yet`);
      }
    } catch (e) {
      return error(`${name} failed: ${e.message}`);
    }
  }

  return { list, call };
}
