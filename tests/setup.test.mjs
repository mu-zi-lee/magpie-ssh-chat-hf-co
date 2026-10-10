import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHostKey } from '../src/host-key.mjs';
import { HuggingFaceSshPlugin } from '../index.mjs';
import { MODEL } from '../src/protocol.mjs';

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

test('installing the plugin offers browser login without creating or overwriting accounts', () => temporary(async directory => {
  const plugin = await HuggingFaceSshPlugin({ project: { id: 'magpie' }, directory,
    client: { auth: { set: () => assert.fail('Installation must not mark an account as authenticated') } },
  });
  assert.equal(plugin.auth.methods[0].type, 'oauth');
  assert.equal(plugin.auth.methods.length, 1);
  const loader = await plugin.auth.loader(async () => ({ type: 'api', key: 'anonymous' }));
  assert.equal(loader.apiKey, 'hf-ssh');
  const response = await loader.fetch('http://localhost/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'hf_login_required');
}));
