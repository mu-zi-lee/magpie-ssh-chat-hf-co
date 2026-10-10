import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const HF_SSH_KEYS_URL = 'https://huggingface.co/settings/keys/add?type=ssh';

const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// The host renders OAuth instructions as plain text. Use the system browser
// for a selectable key and clipboard access, without requiring host UI changes.
export async function createAuthPage(publicKey, fingerprint) {
  const path = '/ssh-key/' + randomUUID();
  const nonce = randomUUID();
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hugging Face SSH 登录 · Magpie</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 48px 20px; background: light-dark(#f6f7f8, #151718); color: light-dark(#202427, #edf0f2); }
  main { max-width: 640px; margin: auto; }
  h1 { margin: 8px 0 20px; font-size: 28px; letter-spacing: -.6px; }
  p { line-height: 1.7; }
  label { display: block; font-weight: 600; margin: 24px 0 8px; }
  textarea { box-sizing: border-box; width: 100%; height: 112px; resize: vertical; padding: 14px; border: 1px solid light-dark(#c5ccd0, #535b60); border-radius: 10px; background: light-dark(#fff, #222629); color: inherit; font: 13px/1.6 ui-monospace, monospace; overflow-wrap: anywhere; }
  .actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 14px 0; }
  button, .link { box-sizing: border-box; padding: 11px 16px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; }
  button { border: 0; background: light-dark(#202427, #edf0f2); color: light-dark(#fff, #202427); }
  .link { display: inline-block; border: 1px solid light-dark(#c5ccd0, #535b60); color: inherit; text-decoration: none; }
  :focus-visible { outline: 3px solid #4784e5; outline-offset: 3px; }
  #status { min-height: 26px; font-size: 14px; }
  .detail { color: light-dark(#525c63, #b2bdc4); font-size: 13px; overflow-wrap: anywhere; }
</style>
<main>
  <p class="detail">MAGPIE · HUGGING FACE</p>
  <h1>添加 SSH 公钥</h1>
  <p>先复制公钥，再打开 Hugging Face 的 SSH Keys 页面。登录后将公钥粘贴到 Key 输入框，名称可填 <strong>Magpie HF SSH</strong>，然后保存。</p>
  <label for="public-key">SSH 公钥</label>
  <textarea id="public-key" readonly spellcheck="false" autocomplete="off">${escape(publicKey)}</textarea>
  <div class="actions">
    <button id="copy" type="button">复制公钥</button>
    <a class="link" href="${HF_SSH_KEYS_URL}" target="_blank" rel="noopener noreferrer">打开 HF 添加页面 ↗</a>
  </div>
  <p id="status" role="status" aria-live="polite"></p>
  <p>保存后返回 Magpie 或登录终端，插件会自动验证并完成登录。此页面仅在本次登录期间有效。</p>
  <p class="detail">指纹：${escape(fingerprint)}</p>
  <p class="detail">这里只显示公钥，私钥保留在运行插件的机器上。浏览器不能复制时，点击公钥框全选后按 Ctrl+C / ⌘C。</p>
</main>
<script nonce="${nonce}">
  const key = document.getElementById('public-key');
  const status = document.getElementById('status');
  key.addEventListener('click', () => { key.focus(); key.select(); });
  document.getElementById('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(key.value);
      status.textContent = '已复制公钥，可以到 HF 页面粘贴。';
    } catch {
      key.focus(); key.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch {}
      status.textContent = copied ? '已复制公钥，可以到 HF 页面粘贴。' : '已全选公钥，请按 Ctrl+C / ⌘C 复制。';
    }
  });
</script>
</html>`;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== path || request.headers.host !== new URL(url).host) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    response.end(html);
  });
  let url;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  url = `http://127.0.0.1:${server.address().port}${path}`;
  return { url, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
