async function streamEvents(client, onEvent) {
  const res = await fetch(`${client.base}/events`, { headers: { accept: 'text/event-stream' } });
  if (!res.ok || !res.body) throw new Error(`event stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (chunk.startsWith(':')) continue;
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) onEvent(event, JSON.parse(data));
      }
    }
  })().catch((err) => process.stderr.write(`[walkie-talkie-mcp] event stream closed: ${err.message}\n`));
  return reader;
}

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

export function buildResources({ server, client, session } = {}) {
  const subscriptions = new Set();
  let reader = null;

  async function ensureStream() {
    if (reader) return;
    reader = await streamEvents(client, (event, payload) => {
      if (event !== 'message.posted') return;
      if (payload.from === session.sessionId) return; // don't notify about own posts
      for (const uri of subscriptions) {
        server.notification({ method: 'notifications/resources/updated', params: { uri } });
      }
    });
  }

  function list() { return RESOURCES; }

  async function read(request) {
    const { uri } = request.params;
    switch (uri) {
      case 'walkie://channel/inbox':
        return jsonResource(uri, await client.inbox(session.sessionId));
      case 'walkie://channel/recent':
        return jsonResource(uri, await client.latest(20, false));
      case 'walkie://sessions/active':
        return jsonResource(uri, await client.sessions());
      default:
        throw new Error(`unknown resource: ${uri}`);
    }
  }

  async function subscribe(request) {
    subscriptions.add(request.params.uri);
    await ensureStream();
    return {};
  }

  async function unsubscribe(request) {
    subscriptions.delete(request.params.uri);
    return {};
  }

  return { list, read, subscribe, unsubscribe };
}
