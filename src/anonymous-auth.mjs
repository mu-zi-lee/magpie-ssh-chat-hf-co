import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ANONYMOUS_AUTH = {
  type: 'api', key: 'anonymous', metadata: { email: '@anonymous' },
};

// Magpie exposes auth.set but no auth.get. Read only this provider's presence
// from its documented auth file; all writes go through the host's locked API.
export async function ensureAnonymousAccount(input, { autoConnect = true } = {}) {
  if (!autoConnect || input.project?.id !== 'magpie' || !input.directory || !input.client?.auth?.set) return;
  let accounts;
  try {
    accounts = JSON.parse(await readFile(join(input.directory, 'plugin-auth.json'), 'utf8'));
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) throw new Error('Invalid Magpie auth file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    accounts = {};
  }
  if (Object.keys(accounts).some(id => id === 'hf-ssh' || id.startsWith('hf-ssh#'))) return;
  await input.client.auth.set({ path: { id: 'hf-ssh' }, body: structuredClone(ANONYMOUS_AUTH) });
}
