import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import ssh2 from 'ssh2';
import { request } from 'node:http';
import { createAuthPage } from '../src/auth-page.mjs';

function requestPage(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text: async () => body }));
      response.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

test('login page copies the complete SSH key and allows manual copying when clipboard access fails', async () => {
  const publicKey = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'magpie-hf-ssh' }).public;
  const page = await createAuthPage(publicKey, 'SHA256:test', { loginAccess: 'local' });
  try {
    const response = await fetch(page.url);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    const value = html.match(/<textarea[^>]*readonly[^>]*>([^<]+)<\/textarea>/)[1];
    const script = html.match(/<script[^>]*>([\s\S]+?)<\/script>/)[1];
    for (const mode of ['clipboard', 'legacy', 'manual']) {
      let copied, selected = false;
      const listeners = {};
      const key = { value, focus() {}, select() { selected = true; }, addEventListener(event, handler) { listeners.key = handler; } };
      const status = { textContent: '' };
      runInNewContext(script, {
        document: {
          getElementById: id => id === 'public-key' ? key : id === 'status' ? status : { addEventListener(event, handler) { listeners.copy = handler; } },
          execCommand(command) {
            assert.equal(command, 'copy');
            if (mode === 'legacy') { copied = selected && key.value; return true; }
            return false;
          },
        },
        navigator: { clipboard: { async writeText(text) {
          if (mode !== 'clipboard') throw new Error('Clipboard permission denied');
          copied = text;
        } } },
      });
      await listeners.copy();
      if (mode === 'manual') {
        assert.equal(selected, true);
        assert.match(status.textContent, /已全选.*Ctrl\+C/);
      } else {
        assert.equal(copied, publicKey);
        assert.deepEqual(ssh2.utils.parseKey(copied).getPublicSSH(), ssh2.utils.parseKey(publicKey).getPublicSSH());
        assert.match(status.textContent, /已复制/);
      }
      selected = false;
      listeners.key();
      assert.equal(selected, true);
    }
    assert.equal((await fetch(new URL('/other', page.url))).status, 404);
    assert.equal((await fetch(page.url, { method: 'POST' })).status, 404);
  } finally { await page.close(); }
});

test('remote login exposes only the random public-key page at the exact tunnel host', async () => {
  let target, closed = 0;
  const origin = 'https://hf-login-fixture.trycloudflare.com';
  const publicKey = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).public;
  const page = await createAuthPage(publicKey, 'SHA256:test', { loginAccess: 'cloudflare' }, {
    createTunnel: async value => { target = value; return { origin, close: async () => { closed++; } }; },
  });
  const local = target + new URL(page.url).pathname;
  try {
    assert.equal(page.remote, true);
    assert.equal(new URL(page.url).origin, origin);
    const response = await requestPage(local, { headers: { host: new URL(origin).host } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(publicKey));
    assert.ok(html.includes('远程通道会随登录结束自动关闭'));
    assert.ok(!html.includes('PRIVATE KEY'));
    assert.equal((await requestPage(local, { headers: { host: 'wrong.trycloudflare.com' } })).status, 404);
    assert.equal((await requestPage(local, { headers: { host: new URL(origin).host, origin: 'https://evil.invalid' } })).status, 404);
    assert.equal((await requestPage(local, { headers: { host: new URL(origin).host, origin: target } })).status, 404);
    assert.equal((await requestPage(target + '/v1/chat/completions', { headers: { host: new URL(origin).host } })).status, 404);
    assert.equal((await requestPage(local + '?unexpected=1', { headers: { host: new URL(origin).host } })).status, 404);
    assert.equal((await requestPage(local, { method: 'POST', headers: { host: new URL(origin).host } })).status, 404);
  } finally { await page.close(); }
  await page.close();
  assert.equal(closed, 1);
  await assert.rejects(fetch(local));
});

test('tunnel startup failures and invalid public origins close the local login listener', async () => {
  for (const origin of [undefined, 'https://fixture.trycloudflare.com.evil.invalid', 'http://fixture.trycloudflare.com', 'https://fixture.trycloudflare.com:8443']) {
    let target, closed = 0;
    await assert.rejects(createAuthPage('test-public-key', 'SHA256:test', { loginAccess: 'cloudflare' }, {
      createTunnel: async value => {
        target = value;
        if (!origin) throw new Error('fixture tunnel failure');
        return { origin, close: async () => { closed++; } };
      },
    }), /tunnel failure|无效/);
    assert.equal(closed, origin ? 1 : 0);
    await assert.rejects(fetch(target));
  }
});
