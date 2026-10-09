import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHostKey } from '../src/host-key.mjs';
import { ensureAnonymousAccount, ANONYMOUS_AUTH } from '../src/anonymous-auth.mjs';
import { HuggingFaceSshPlugin } from '../index.mjs';

async function temporary(action) {
  const directory = await mkdtemp(join(tmpdir(), 'hf-ssh-test-'));
  try { await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('first connection persists a host key; subsequent mismatches are rejected', () => temporary(async directory => {
  assert.equal(await verifyHostKey(directory, 'chat.hf.co', 22, Buffer.from('first key')), true);
  assert.equal(await verifyHostKey(directory, 'chat.hf.co', 22, Buffer.from('first key')), true);
  assert.equal(await verifyHostKey(directory, 'chat.hf.co', 22, Buffer.from('other key')), false);
  assert.equal(await verifyHostKey(directory, 'chat.hf.co', 2222, Buffer.from('other key')), true);
  assert.equal((await readdir(join(directory, 'host-keys'))).length, 2);
}));

test('concurrent initialization agrees on one host key', () => temporary(async directory => {
  const accepted = await Promise.all(Array.from({ length: 6 }, () => verifyHostKey(directory, 'chat.hf.co', 22, Buffer.from('same key'))));
  assert.deepEqual(accepted, Array(6).fill(true));
}));

test('Magpie installs automatically register an anonymous account through the SDK', () => temporary(async directory => {
  const calls = [];
  await ensureAnonymousAccount({ project: { id: 'magpie' }, directory, client: { auth: { set: async value => calls.push(value) } } });
  assert.deepEqual(calls, [{ path: { id: 'hf-ssh' }, body: ANONYMOUS_AUTH }]);
}));

test('automatic setup preserves an existing provider account and unrelated credentials', () => temporary(async directory => {
  for (const accounts of [{ 'hf-ssh': { type: 'api', key: 'existing' }, other: { key: 'secret' } }, { 'hf-ssh#other': { type: 'oauth', access: 'existing' } }]) {
    const path = join(directory, 'plugin-auth.json');
    await writeFile(path, JSON.stringify(accounts));
    const before = await readFile(path, 'utf8');
    await ensureAnonymousAccount({ project: { id: 'magpie' }, directory, client: { auth: { set: async () => { throw new Error('Must not overwrite'); } } } });
    assert.equal(await readFile(path, 'utf8'), before);
  }
}));

test('autoConnect can be disabled; corrupt auth files fail without replacing credentials', () => temporary(async directory => {
  const input = { project: { id: 'magpie' }, directory, client: { auth: { set: async () => { throw new Error('Must not write'); } } } };
  await ensureAnonymousAccount(input, { autoConnect: false });
  await writeFile(join(directory, 'plugin-auth.json'), '{incomplete');
  await assert.rejects(ensureAnonymousAccount(input));
}));

test('anonymous loader works without a manually entered key', async () => {
  const plugin = await HuggingFaceSshPlugin();
  const loader = await plugin.auth.loader(async () => undefined);
  assert.equal(loader.apiKey, 'anonymous');
  assert.equal(typeof loader.fetch, 'function');
});
