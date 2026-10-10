import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import ssh2 from 'ssh2';
import { createAuthPage } from '../src/auth-page.mjs';

test('login page copies the complete SSH key and allows manual copying when clipboard access fails', async () => {
  const publicKey = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'magpie-hf-ssh' }).public;
  const page = await createAuthPage(publicKey, 'SHA256:test');
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
