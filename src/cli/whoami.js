import { clientForProject, resolveSelf } from './client.js';

/**
 * Answer "who am I, on which channel, with what authority, until when" — read from the
 * service, not from the credential document, because the document cannot know it was revoked.
 */
export async function whoamiCommand(opts = {}) {
  const client = clientForProject();
  const { context } = client;
  const { self, drift } = await resolveSelf(client);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          namespace: context.namespace,
          mode: context.mode,
          principalId: self.principalId,
          displayAlias: self.displayAlias ?? null,
          role: self.role,
          scopes: self.scopes ?? [],
          capabilityId: self.capabilityId,
          expiresAt: self.expiresAt ?? null,
          credentialDrift: drift
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const alias = self.displayAlias ? `@${self.displayAlias}` : '(no alias)';
  const lines = [
    `namespace:  ${context.namespace} (${context.mode})`,
    `principal:  ${self.principalId}  ${alias}`,
    `role:       ${self.role}`,
    `scopes:     ${(self.scopes ?? []).join(', ') || '(none)'}`,
    `capability: ${self.capabilityId}`,
    `expires:    ${self.expiresAt ?? 'never'}`
  ];
  if (drift.length) {
    lines.push(
      '',
      `note: your operator credential file disagrees with the service on ${drift.join(', ')}.`,
      '      The service is authoritative; the file is stale and should be re-issued.'
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}
