import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Trust a key on the first connection; never replace an existing pin silently.
export async function verifyHostKey(stateDir, host, port, key) {
  const digest = createHash('sha256').update(key).digest('hex');
  const id = createHash('sha256').update(`${host}:${port}`).digest('hex');
  const directory = join(stateDir, 'host-keys');
  const file = join(directory, `${id}.sha256`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, digest + '\n', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  // A second plugin host can encounter the pin just before its first write finishes.
  for (let attempt = 0; attempt < 4; attempt++) {
    const saved = (await readFile(file, 'utf8')).trim();
    if (saved) return saved === digest;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('SSH host key cache is incomplete; refusing the connection');
}
