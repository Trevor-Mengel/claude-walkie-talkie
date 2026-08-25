/**
 * MCP resources.
 *
 * The one behavioural change that matters: `collabcast://channel/inbox` used to CONSUME the read
 * cursor. A resource read is a passive fetch an MCP client may perform on its own initiative —
 * on refresh, on reconnect, on a subscription notification — so consuming state made messages
 * vanish without anyone deciding to acknowledge them. Every read here is now strictly
 * non-mutating; acknowledging is the explicit `collabcast_ack` tool.
 */

import { isCollabcastError, collabcastError } from '../identity/errors.js';

const RESOURCES = [
  {
    uri: 'collabcast://channel/inbox',
    name: 'Inbox (new since last read)',
    description:
      'Messages new to this principal since its read cursor. Reading this resource does not ' +
      'move the cursor. Subscribable: clients are notified when new messages arrive.',
    mimeType: 'application/json'
  },
  {
    uri: 'collabcast://channel/recent',
    name: 'Recent messages',
    description: 'Snapshot of the last 20 channel messages, newest first.',
    mimeType: 'application/json'
  },
  {
    uri: 'collabcast://sessions/active',
    name: 'Channel roster',
    description: 'Every principal on the channel with its role and display alias.',
    mimeType: 'application/json'
  }
];

function jsonResource(uri, data) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

/**
 * @param {object} deps
 * @param {{notification:Function}} deps.server
 * @param {object} deps.api
 * @param {ReturnType<import('./capability.js').createCapabilityHolder>} deps.capability
 * @param {(onEvent:Function, onError?:Function)=>Promise<{close:()=>void}>} deps.events
 */
export function buildResources({ server, api, capability, events } = {}) {
  /** Only a URI in RESOURCES may be subscribed, which also bounds this set to its size. */
  const subscriptions = new Set();
  /** @type {{close:()=>void}|null} */
  let stream = null;
  /** In-flight `events()` call, so two concurrent subscribes cannot open two streams. */
  /** @type {Promise<void>|null} */
  let opening = null;
  /** @type {'idle'|'live'|'faulted'} */
  let streamState = 'idle';

  /**
   * Tell the CLIENT something happened to its subscriptions.
   *
   * The previous behaviour wrote one line to stderr and stopped. stderr is the server process's
   * log, not a channel the MCP client reads, so a subscription could die and the client would
   * go on believing it was subscribed — waiting forever for notifications that could no longer
   * arrive, with no signal and no error. `notifications/message` is the MCP-visible equivalent
   * and costs nothing.
   *
   * @param {'info'|'warning'|'error'} level
   * @param {string} message
   * @param {object} [extra]
   */
  function tellClient(level, message, extra = {}) {
    server.notification({
      method: 'notifications/message',
      params: {
        level,
        logger: 'collabcast.subscriptions',
        data: { message, subscriptions: [...subscriptions], ...extra }
      }
    });
  }

  /** Wake every subscriber. Used on a new message, and after a gap they may have missed. */
  function notifySubscribers() {
    for (const uri of subscriptions) {
      server.notification({ method: 'notifications/resources/updated', params: { uri } });
    }
  }

  function onEvent(identity) {
    return (name, payload) => {
      if (name !== 'message.posted') return;
      // The service emits `from: <principalId>`. Don't wake a client about its own post.
      if (payload?.from && payload.from === identity.principalId) return;
      notifySubscribers();
    };
  }

  /**
   * The feed died. Report it to the client, then try once to get it back.
   *
   * One attempt, not a loop: a retry loop against a service that is down is a reconnect storm,
   * and `subscribe` already re-arms a null stream, so a client that resubscribes recovers too.
   * What must never happen again is silence.
   *
   * @param {unknown} err
   */
  function onStreamError(err) {
    stream = null;
    streamState = 'faulted';
    const code = isCollabcastError(err) ? err.code : 'error';
    process.stderr.write(`[collabcast-mcp] event feed closed: ${code}\n`);
    if (subscriptions.size === 0) return;
    tellClient(
      'warning',
      'the collabcast event feed closed, so live notifications have stopped; reconnecting once — ' +
        'if this is not followed by a recovery notice, re-subscribe or poll the resource',
      { code, live: false }
    );
    // Floating on purpose: nothing awaits a feed that died on its own.
    void reopen().then(
      () => {
        tellClient('info', 'the collabcast event feed is live again', { live: true });
        // Anything posted while the feed was down was never notified. One wake per subscribed
        // resource, so a client that only watches resource updates still re-reads once.
        notifySubscribers();
      },
      (reopenErr) => {
        tellClient(
          'error',
          'the collabcast event feed could not be reopened; this session will send no further ' +
            'resource notifications until you subscribe again',
          { code: isCollabcastError(reopenErr) ? reopenErr.code : 'error', live: false }
        );
      }
    );
  }

  async function reopen() {
    const identity = capability.requireActive();
    stream = await events(onEvent(identity), onStreamError);
    streamState = 'live';
  }

  async function ensureStream() {
    if (stream) return;
    // Coalesce concurrent opens. Without this, two subscribes racing on a null `stream` each
    // call `events()` and the first handle is overwritten and leaked — an orphan HTTP request
    // holding the socket open with nobody able to close it.
    if (!opening) {
      opening = reopen().finally(() => {
        opening = null;
      });
    }
    await opening;
  }

  function list() {
    return RESOURCES;
  }

  /** @param {string} uri */
  function requireResource(uri) {
    const known = RESOURCES.some((resource) => resource.uri === uri);
    if (!known) throw collabcastError('not_found', `there is no collabcast resource at ${uri}`);
    return uri;
  }

  async function read(request) {
    const uri = requireResource(request.params.uri);
    capability.requireActive();
    switch (uri) {
      case 'collabcast://channel/inbox':
        return jsonResource(uri, await api.inbox());
      case 'collabcast://channel/recent':
        return jsonResource(uri, await api.latest(20, false));
      default:
        return jsonResource(uri, await api.principals());
    }
  }

  async function subscribe(request) {
    // `subscribe` used to `subscriptions.add(request.params.uri)` first and validate never.
    // Any string a client sent was retained forever in a Set nothing bounded, so a client
    // could grow the server's memory with junk URIs and be told it had subscribed to a
    // resource that does not exist — then wait indefinitely for notifications about it.
    const uri = requireResource(request.params.uri);
    // And a subscribe that could not arm the feed must leave nothing behind: registering the
    // URI before the stream opened meant a rejected subscribe still looked subscribed.
    await ensureStream();
    subscriptions.add(uri);
    return {};
  }

  async function unsubscribe(request) {
    subscriptions.delete(request.params.uri);
    if (subscriptions.size === 0 && stream) {
      stream.close();
      stream = null;
      streamState = 'idle';
    }
    return {};
  }

  return {
    list,
    read,
    subscribe,
    unsubscribe,
    /** Feed health, so a caller can tell "never armed" from "armed and dead". */
    streamState: () => streamState,
    subscribed: () => [...subscriptions]
  };
}
