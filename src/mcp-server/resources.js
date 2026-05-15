export function buildResources({ server: _server, client: _client, session: _session } = {}) {
  function list() { return []; }
  async function read(_request) { return { contents: [] }; }
  async function subscribe(_request) { return {}; }
  async function unsubscribe(_request) { return {}; }
  return { list, read, subscribe, unsubscribe };
}
