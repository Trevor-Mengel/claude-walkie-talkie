const RESOURCES = [
  {
    uri: 'walkie://channel/inbox',
    name: 'Inbox (new since last read)',
    description: 'Messages new to this session since the last read. Subscribable: clients get notified when new messages arrive.',
    mimeType: 'application/json'
  },
  {
    uri: 'walkie://channel/recent',
    name: 'Recent messages',
    description: 'Snapshot of the last 20 channel messages, newest first.',
    mimeType: 'application/json'
  },
  {
    uri: 'walkie://sessions/active',
    name: 'Active sessions',
    description: 'Active sessions and pending invitations.',
    mimeType: 'application/json'
  }
];

function jsonResource(uri, data) {
  return {
    contents: [
      { uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }
    ]
  };
}

export function buildResources({ server: _server, client, session } = {}) {
  function list() { return RESOURCES; }

  async function read(request) {
    const { uri } = request.params;
    switch (uri) {
      case 'walkie://channel/inbox': {
        const data = await client.inbox(session.sessionId);
        return jsonResource(uri, data);
      }
      case 'walkie://channel/recent': {
        const data = await client.latest(20, false);
        return jsonResource(uri, data);
      }
      case 'walkie://sessions/active': {
        const data = await client.sessions();
        return jsonResource(uri, data);
      }
      default:
        throw new Error(`unknown resource: ${uri}`);
    }
  }

  async function subscribe(_request) { return {}; }
  async function unsubscribe(_request) { return {}; }

  return { list, read, subscribe, unsubscribe };
}
