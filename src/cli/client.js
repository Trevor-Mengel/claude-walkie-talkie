// src/cli/client.js
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function clientForProject(projectRoot) {
  const portFile = join(projectRoot, '.walkie-talkie', 'server.port');
  if (!existsSync(portFile)) {
    throw new Error('daemon is not running (no server.port file). Run `walkie start` first.');
  }
  const port = Number(readFileSync(portFile, 'utf8').trim());
  const base = `http://127.0.0.1:${port}`;
  async function req(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${typeof parsed === 'string' ? parsed : parsed.error || parsed.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }
  return {
    base,
    health: () => req('GET', '/health'),
    latest: (limit = 5, includeArchived = false) =>
      req('GET', `/channel/latest?limit=${limit}&include_archived=${includeArchived}`),
    since: (id) => req('GET', `/channel/since/${id}`),
    message: (id) => req('GET', `/channel/message/${id}`),
    post: (data) => req('POST', '/channel/message', data),
    edit: (id, data) => req('PATCH', `/channel/message/${id}`, data),
    archive: (id, data) => req('POST', `/channel/message/${id}/archive`, data),
    sessions: () => req('GET', '/sessions'),
    join: (data) => req('POST', '/sessions/join', data),
    rename: (id, alias) => req('POST', `/sessions/${id}/rename`, { alias }),
    invite: (alias) => req('POST', '/sessions/invite', { alias }),
    listPermits: () => req('GET', '/permits'),
    grantPermit: (data) => req('POST', '/permits', data),
    revokePermit: (sessionId) => req('DELETE', `/permits/${sessionId}`)
  };
}
