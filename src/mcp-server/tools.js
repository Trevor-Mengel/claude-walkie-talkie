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
    description: 'Latest N messages (any session, any time). Stub.',
    inputSchema: { type: 'object', properties: {} }
  },
  walkie_talk: {
    description: 'Post a message. Use @mentions in the body to direct attention. Stub.',
    inputSchema: { type: 'object', properties: {} }
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
        default:
          return error(`tool ${name} not implemented yet`);
      }
    } catch (e) {
      return error(`${name} failed: ${e.message}`);
    }
  }

  return { list, call };
}
