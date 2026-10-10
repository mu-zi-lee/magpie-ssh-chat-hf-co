import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, isAbsolute, resolve as absolute } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveCloudflared } from './cloudflared-runtime.mjs';

const supervisor = fileURLToPath(new URL('./owned-process.mjs', import.meta.url));

export function remoteLoginByDefault(options = {}, env = process.env, platform = process.platform) {
  const mode = options.loginAccess ?? 'auto';
  if (!['auto', 'local', 'cloudflare'].includes(mode)) throw new Error('loginAccess 必须是 auto、local 或 cloudflare');
  return mode === 'cloudflare' || mode === 'auto' &&
    (Boolean(env.SSH_CONNECTION || env.SSH_TTY) || platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY);
}

export function quickTunnelOrigin(output) {
  for (const candidate of String(output).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=$|[\s|])/g) ?? []) {
    const url = new URL(candidate);
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(url.hostname)) return url.origin;
  }
}

// Each tunnel exposes only its temporary login listener. It never forwards the
// Magpie gateway, model API, saved credentials or upstream SSH connection.
export async function createCloudflareTunnel(target, options = {}, dependencies = {}) {
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port ||
      upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('Cloudflare 登录通道只允许本机临时 HTTP 监听地址');
  }
  const launch = dependencies.spawn ?? spawn;
  const resolve = dependencies.resolve ?? resolveCloudflared;
  const pollDelay = dependencies.pollDelay ?? delay;
  const signal = AbortSignal.any([AbortSignal.timeout(options.tunnelTimeoutMs ?? 45000), ...(options.signal ? [options.signal] : [])]);
  const dataDir = absolute(options.stateDir ?? 'hf-ssh-state');
  let directory, child, exit, closing, output = '', origin, registered = false, disposed = false;
  const close = () => {
    if (closing) return closing;
    disposed = true;
    options.signal?.removeEventListener('abort', onAbort);
    closing = (async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        try { child.stdin.end(); child.kill('SIGTERM'); await exit; }
        finally { clearTimeout(timer); }
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    })();
    return closing;
  };
  const onAbort = () => { void close().catch(() => {}); };
  try {
    signal.throwIfAborted();
    let binary = await resolve({ ...options, signal }, dataDir, dependencies);
    signal.throwIfAborted();
    if (!isAbsolute(binary) && (binary.includes('/') || binary.includes('\\'))) binary = absolute(binary);
    const temporary = join(dataDir, 'temporary');
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(temporary, 'cloudflare-login-'));
    const config = join(directory, 'config.yaml');
    await writeFile(config, '{}\n', { mode: 0o600 });
    signal.throwIfAborted();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^(TUNNEL_|CLOUDFLARED_)/.test(key)) delete env[key];
    child = launch(process.execPath, [supervisor, String(process.pid), binary, 'tunnel', '--config', config,
      '--no-autoupdate', '--url', upstream.origin, '--protocol', 'http2', '--edge-ip-version', '4', '--metrics', '127.0.0.1:0'],
    { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    exit = new Promise(resolve => child.once('close', resolve));
    const collect = chunk => {
      output = (output + chunk.toString()).slice(-32768);
      origin ??= quickTunnelOrigin(output);
      registered ||= /Registered tunnel connection/.test(output);
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.stdin.on('error', () => {});
    child.on('error', () => { child.failure = true; });
    child.once('close', () => { void close().catch(() => {}); });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    for (;;) {
      signal.throwIfAborted();
      if (disposed || child.failure || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Cloudflare 临时登录通道启动失败，请检查服务器网络或 cloudflaredPath');
      }
      if (origin && registered) return { origin, close };
      await pollDelay(dependencies.pollMs ?? 100, undefined, { signal });
    }
  } catch (error) {
    await close();
    if (signal.aborted && !options.signal?.aborted) {
      throw new Error('Cloudflare 临时登录通道启动超时，请检查 GitHub 和 Cloudflare 的出站网络，或选择本机登录');
    }
    throw error;
  }
}
