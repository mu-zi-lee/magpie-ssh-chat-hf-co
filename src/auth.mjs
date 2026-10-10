import ssh2 from 'ssh2';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { SshTerminal } from './terminal.mjs';
import { BridgeError } from './protocol.mjs';

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
export async function authorizeSsh(options = {}, { Terminal = SshTerminal, pollDelay = delay } = {}) {
  const keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'magpie-hf-ssh' });
  const fingerprint = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(keys.private).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.loginTimeoutMs ?? 10 * 60 * 1000), ...(options.signal ? [options.signal] : [])]);
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
    try {
      for (;;) {
        signal.throwIfAborted();
        let account;
        try {
          account = signedInAccount(await connect());
          if (account) {
            // A second connection proves that this is reusable authorization,
            // rather than an in-session /login that disappears on disconnect.
            const verified = signedInAccount(await connect());
            if (verified === account) {
              return { type: 'success', key: keys.private, metadata: { email: '@' + account, authMode: 'hf-ssh', sshFingerprint: fingerprint } };
            }
          }
        } catch (error) {
          if (signal.aborted || error.code !== 'hf_login_required') throw error;
        }
        await pollDelay(options.loginPollMs ?? 5000, undefined, { signal });
      }
    } catch (error) {
      const expired = signal.aborted && !controller.signal.aborted && !options.signal?.aborted;
      return { type: 'failed', error: expired ? 'HF login timed out. Start sign-in again to get a new public key.' : error.message };
    } finally { signal.removeEventListener('abort', disconnect); }
  })();
  return {
    url: 'https://huggingface.co/settings/keys/add?type=ssh',
    instructions: `登录 Hugging Face，在 SSH Keys 页面添加以下公钥，名称可填 Magpie HF SSH。添加成功后返回，插件会自动验证。请只复制以 ecdsa-sha2-nistp256 开头的这一行：\n\n${keys.public}\n\n指纹：${fingerprint}`,
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
