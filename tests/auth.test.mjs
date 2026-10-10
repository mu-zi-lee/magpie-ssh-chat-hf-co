import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeSsh, privateKeyFromAuth, readLocalAuth, saveLocalAuth, signedInAccount } from '../src/auth.mjs';
import { BridgeError, MODEL } from '../src/protocol.mjs';
import { createBridge } from '../src/bridge.mjs';

const accountScreen = `🤗 ssh chat ${MODEL} @test-user\n┃ Ask anything`;
const loginGate = () => new BridgeError('Key is not linked', 403, 'hf_login_required');

test('anonymous or echoed usernames do not confirm SSH login', () => {
  assert.equal(signedInAccount(`🤗 ssh chat ${MODEL} @anonymous\n┃ Ask anything`), undefined);
  assert.equal(signedInAccount('User said @test-user\n┃ Ask anything'), undefined);
  assert.equal(signedInAccount(accountScreen), 'test-user');
});

test('browser linking waits for approval and verifies two connections with the same public key', async () => {
  let approve, linked = false, waiting;
  const approved = new Promise(resolve => { approve = () => { linked = true; resolve(); }; });
  const waitingForLink = new Promise(resolve => { waiting = resolve; });
  const instances = [];
  class Terminal {
    constructor(options) { this.options = options; this.closed = 0; instances.push(this); }
    async ready() { if (!linked) throw loginGate(); return accountScreen; }
    async close() { this.closed++; }
  }
  const login = await authorizeSsh({}, { Terminal, pollDelay: async () => { waiting(); await approved; } });
  assert.equal(login.method, 'auto');
  assert.equal(new URL(login.url).hostname, '127.0.0.1');
  const publicKey = login.instructions.match(/ecdsa-sha2-nistp256 [A-Za-z0-9+/=]+ magpie-hf-ssh/)[0];
  assert.ok(ssh2.utils.parseKey(publicKey).getPublicSSH());
  assert.ok(!login.instructions.includes('PRIVATE KEY'));
  let settled = false;
  const callback = login.callback().then(result => { settled = true; return result; });
  await waitingForLink;
  assert.equal(settled, false);
  const pageResponse = await fetch(login.url);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  assert.ok(page.includes(publicKey));
  assert.ok(page.includes('复制公钥'));
  assert.ok(page.includes('https://huggingface.co/settings/keys/add?type=ssh'));
  assert.ok(!page.includes('PRIVATE KEY'));
  approve();
  const result = await callback;
  assert.equal(result.type, 'success');
  assert.equal(privateKeyFromAuth({ ...result, type: 'api' }), result.key);
  assert.equal(result.metadata.email, '@test-user');
  assert.match(result.metadata.sshFingerprint, /^SHA256:/);
  assert.equal(instances.length, 3);
  assert.ok(instances.every(instance => instance.options.privateKey === result.key));
  assert.ok(instances.every(instance => instance.closed === 1));
  assert.deepEqual(ssh2.utils.parseKey(result.key).getPublicSSH(), ssh2.utils.parseKey(publicKey).getPublicSSH());
  assert.deepEqual(await login.callback(), result);
  await assert.rejects(fetch(login.url));
});

test('a login that fails on verification never returns a credential', async () => {
  let closed = 0, connected = 0;
  class Terminal {
    async ready() { if (++connected === 2) throw new Error('Verification connection failed'); return accountScreen; }
    async close() { closed++; }
  }
  const result = await (await authorizeSsh({}, { Terminal })).callback();
  assert.equal(result.type, 'failed');
  assert.equal(result.key, undefined);
  assert.equal(closed, 2);
});

test('canceling an unfinished login disconnects SSH and leaves no successful result', async () => {
  let closed = 0, disconnected = 0;
  class Terminal {
    async ready(signal) {
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    disconnect() { disconnected++; }
    async close() { closed++; }
  }
  const login = await authorizeSsh({}, { Terminal });
  login.cancel();
  assert.equal((await login.callback()).type, 'failed');
  assert.equal(closed, 1);
  assert.equal(disconnected, 1);
  await assert.rejects(fetch(login.url));
});

test('an abandoned browser link expires without saving a private key', async () => {
  let closed = 0;
  class Terminal {
    async ready() { throw loginGate(); }
    async close() { closed++; }
  }
  const result = await (await authorizeSsh({ loginTimeoutMs: 20, loginPollMs: 5 }, { Terminal })).callback();
  assert.equal(result.type, 'failed');
  assert.match(result.error, /timed out/);
  assert.equal(result.key, undefined);
  assert.ok(closed >= 1);
});

test('standalone credentials survive restarts, remain private and reject anonymous placeholders', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hf-ssh-auth-'));
  try {
    assert.equal(await readLocalAuth(directory), undefined);
    for (const auth of [undefined, { type: 'api', key: 'anonymous' }, { type: 'api', key: 'not a PRIVATE KEY' }]) {
      assert.throws(() => privateKeyFromAuth(auth), { code: 'hf_login_required' });
    }
    const result = { key: ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private, metadata: { email: '@test-user' } };
    await saveLocalAuth(directory, result);
    assert.equal(privateKeyFromAuth(await readLocalAuth(directory)), result.key);
    assert.equal(JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')).metadata.email, '@test-user');
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'auth.json'))).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['auth.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('each bridge request reads its current key and rejects removed credentials before SSH', async () => {
  let key = 'account-a-key';
  const received = [];
  const bridge = createBridge({ getPrivateKey: async () => {
    if (!key) throw loginGate();
    return key;
  } }, { complete: async (_, settings) => { received.push(settings.privateKey); return { role: 'assistant', content: 'ok' }; } });
  const request = () => bridge.fetch('http://localhost/v1/chat/completions', { method: 'POST',
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal((await request()).status, 200);
  key = 'account-b-key';
  assert.equal((await request()).status, 200);
  key = undefined;
  assert.equal((await request()).status, 403);
  assert.deepEqual(received, ['account-a-key', 'account-b-key']);
});
