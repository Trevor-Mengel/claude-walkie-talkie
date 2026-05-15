export function buildTools() {
  const names = [
    'walkie_inbox',
    'walkie_read',
    'walkie_talk',
    'walkie_reply',
    'walkie_edit',
    'walkie_archive',
    'walkie_sessions',
    'walkie_rename'
  ];
  function list() {
    return names.map((name) => ({
      name,
      description: `${name} (stub — implemented in later tasks)`,
      inputSchema: { type: 'object', properties: {} }
    }));
  }
  async function call(_request) {
    return { content: [{ type: 'text', text: 'not implemented' }], isError: true };
  }
  return { list, call };
}
