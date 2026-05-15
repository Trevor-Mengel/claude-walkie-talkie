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
    description: 'Reply to a specific message. Stub.',
    inputSchema: { type: 'object', properties: {} }
  },
  walkie_edit: {
    description: 'Edit a message you authored. Stub.',
    inputSchema: { type: 'object', properties: {} }
  },
  walkie_archive: {
    description: 'Archive a message. Stub.',
    inputSchema: { type: 'object', properties: {} }
  },
  walkie_sessions: {
    description: 'List active sessions and pending invitations. Stub.',
    inputSchema: { type: 'object', properties: {} }
  },
  walkie_rename: {
    description: "Change this session's alias. Stub.",
    inputSchema: { type: 'object', properties: {} }
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
        default:
          return error(`tool ${name} not implemented yet`);
      }
    } catch (e) {
      return error(`${name} failed: ${e.message}`);
    }
  }

  return { list, call };
}
