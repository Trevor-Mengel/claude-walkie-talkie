let cached = null;

export async function resolveSession({ client, tool, alias }) {
  if (cached) return cached;
  const joined = await client.join({ tool, alias });
  cached = joined;
  return joined;
}

export function resetSessionCache() {
  cached = null;
}

export function getCachedSession() {
  return cached;
}
