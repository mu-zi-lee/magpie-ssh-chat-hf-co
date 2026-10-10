import ssh2 from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { SshTerminal } from './terminal.mjs';
import { BridgeError } from './protocol.mjs';
import { createAuthPage, HF_SSH_KEYS_URL } from './auth-page.mjs';
import { isTransientSshError } from './ssh-errors.mjs';

export function signedInAccount(screen) {
  const match = screen.match(/^\s*🤗\s+ssh chat\s+[^\n]+?\s+@([a-z0-9][a-z0-9_.-]*)\s*$/im);
  return match && match[1].toLowerCase() !== 'anonymous' ? match[1] : undefined;
}

export function privateKeyFromAuth(auth) {
  const parsed = auth?.type === 'api' && typeof auth.key === 'string' && auth.key.includes('PRIVATE KEY')
    ? ssh2.utils.parseKey(auth.key) : undefined;
  if (!parsed || parsed instanceof Error || !parsed.isPrivateKey()) {
    throw new BridgeError('Sign in to Hugging Face SSH with the browser login method. The old anonymous configuration is not a linked SSH key.', 403, 'hf_login_required');
  }
  return auth.key;
}

// Native SSH /login authorizes its current session, but our live check showed
// that it did not link the key for a new connection. HF's SSH key settings page
// links the public key permanently; only the user submits it in the browser.
export async function authorizeSsh(options = {}, { Terminal = SshTerminal, pollDelay = delay, createPage = createAuthPage } = {}) {
  const keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'magpie-hf-ssh' });
  const fingerprint = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(keys.private).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.loginTimeoutMs ?? 10 * 60 * 1000), ...(options.signal ? [options.signal] : [])]);
  const page = await createPage(keys.public, fingerprint, { ...options, signal });
  const settings = { ...options, privateKey: keys.private };
  let terminal;
  const disconnect = () => terminal?.disconnect();
  signal.addEventListener('abort', disconnect, { once: true });
  const connect = async () => {
    signal.throwIfAborted();
    terminal = new Terminal(settings);
    try { return await terminal.ready(signal); }
    finally { await terminal.close(); terminal = undefined; }
  };
  const result = (async () => {
    let lastIssue = 'SSH 公钥尚未关联到 HF 账号。请确认添加的是本次登录页上的完整公钥。';
    try {
      for (;;) {
        signal.throwIfAborted();
        let account;
        try {
          account = signedInAccount(await connect());
          lastIssue = account
            ? '已识别 HF 账号，正在验证密钥能否再次连接。'
            : 'SSH 已连接，但未识别到已登录的 HF 账号。请确认添加的是本次登录页上的完整公钥。';
          if (account) {
            // A second connection proves that this is reusable authorization,
            // rather than an in-session /login that disappears on disconnect.
            const verified = signedInAccount(await connect());
            if (verified === account) {
              return { type: 'success', key: keys.private, metadata: { email: '@' + account, authMode: 'hf-ssh', sshFingerprint: fingerprint } };
            }
            lastIssue = '再次连接时未识别到同一 HF 账号，等待公钥关联生效。';
          }
        } catch (error) {
          if (signal.aborted) throw error;
          if (error.code === 'hf_login_required' || error.level === 'client-authentication') {
            lastIssue = 'SSH 公钥尚未关联到 HF 账号。请确认添加的是本次登录页上的完整公钥。';
          } else if (isTransientSshError(error)) {
            // Linking and verification both use fresh connections. A temporary
            // connection failure must not invalidate the key being added.
            lastIssue = `无法连接 ${settings.host ?? 'chat.hf.co'}:${settings.port ?? 22}：${error.message}。SSH 连接不经过 Magpie 的 HTTP 代理。`;
          } else throw error;
        }
        await pollDelay(options.loginPollMs ?? 5000, undefined, { signal });
      }
    } catch (error) {
      const expired = signal.aborted && !controller.signal.aborted && !options.signal?.aborted;
      return { type: 'failed', error: expired ? `HF login timed out. ${lastIssue} 请重新发起登录并使用新的公钥。` : error.message };
    } finally {
      signal.removeEventListener('abort', disconnect);
      await page.close();
    }
  })();
  return {
    url: page.url,
    instructions: `打开登录页，点击「复制公钥」，再点击「打开 HF 添加页面」并粘贴保存。添加成功后返回，插件会自动验证。${page.remote ? '临时 HTTPS 登录页可以在你的电脑浏览器中打开，登录结束后自动关闭。首次访问若提示 DNS 错误，请稍等再刷新。' : '登录页需在运行插件的机器上打开；跨设备访问请选 Cloudflare 远程登录。'}\n\n也可复制以下完整公钥并打开 ${HF_SSH_KEYS_URL}：\n\n${keys.public}\n\n指纹：${fingerprint}`,
    method: 'auto',
    callback: () => result,
    cancel: () => controller.abort(new DOMException('HF login canceled', 'AbortError')),
  };
}

export async function readLocalAuth(stateDir) {
  try { return JSON.parse(await readFile(join(stateDir, 'auth.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Unable to read local HF SSH credentials; run the login command again.'); }
}

export async function saveLocalAuth(stateDir, result) {
  const auth = { type: 'api', key: result.key, metadata: result.metadata };
  privateKeyFromAuth(auth);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const temporary = join(stateDir, `auth-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(auth), { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(stateDir, 'auth.json'));
  } finally { await rm(temporary, { force: true }); }
}
