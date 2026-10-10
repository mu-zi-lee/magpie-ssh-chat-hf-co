import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installCloudflared, resolveCloudflared, cloudflaredRelease, CLOUDFLARED_VERSION } from '../src/cloudflared-runtime.mjs';
import { createCloudflareTunnel, quickTunnelOrigin, remoteLoginByDefault } from '../src/cloudflare-tunnel.mjs';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await pause(30); } throw new Error('fixture timed out'); }
async function scratch(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-cloudflare-test-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

test('Cloudflare platform pins, explicit binary validation and remote mode', async () => {
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]) {
    const release = cloudflaredRelease(platform, arch); assert.match(release.hash, /^[a-f0-9]{64}$/); assert.match(release.binaryHash, /^[a-f0-9]{64}$/);
    assert.ok(release.url.startsWith(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/`));
  }
  assert.throws(() => cloudflaredRelease('win32', 'arm64'), /cloudflaredPath/);
  assert.equal(remoteLoginByDefault({ loginAccess: 'cloudflare' }, {}, 'darwin'), true);
  const execute = async () => { throw new Error('private failure'); };
  await assert.rejects(resolveCloudflared({ cloudflaredPath: '/missing' }, '/unused', { execute }), /cloudflaredPath/);
  await assert.rejects(resolveCloudflared({ autoInstallCloudflared: false }, '/unused', { execute }), /autoInstallCloudflared/);
});

test('verified cloudflared binary: concurrent install, cache integrity, offline reuse and failure before execution', { skip: process.platform === 'win32' }, async t => {
  const dir = await scratch(t);
  const bytes = Buffer.from(`#!/bin/sh\nprintf 'cloudflared version ${CLOUDFLARED_VERSION}\\n'\n`);
  const release = { ...cloudflaredRelease('linux', 'x64'), hash: hash(bytes), binaryHash: hash(bytes), bytes: bytes.length };
  let downloads = 0;
  const dependencies = { release, fetch: async (url, options) => { downloads++; assert.equal(url, release.url); assert.equal(options.redirect, 'manual'); return new Response(bytes); } };
  const data = path.join(dir, 'data');
  const [first, second] = await Promise.all([installCloudflared(data, dependencies), installCloudflared(data, dependencies)]);
  assert.equal(first, second); assert.equal(downloads, 1);
  assert.equal(await installCloudflared(data, { ...dependencies, fetch() { throw new Error('offline'); } }), first);
  await fs.writeFile(first, 'tampered'); await installCloudflared(data, dependencies); assert.equal(downloads, 2);
  assert.deepEqual(await fs.readFile(first), bytes);
  assert.equal((await fs.stat(first)).mode & 0o777, 0o700);
  assert.ok((await fs.readFile(path.join(path.dirname(first), 'LICENSE'), 'utf8')).includes('Apache License'));
  let executions = 0;
  await assert.rejects(installCloudflared(path.join(dir, 'bad'), { ...dependencies,
    release: { ...release, hash: '0'.repeat(64) }, execute: async () => { executions++; throw new Error(); } }), /SHA-256/);
  assert.equal(executions, 0); assert.deepEqual(await fs.readdir(path.join(dir, 'bad/runtime')), []);
  const outside = path.join(dir, 'outside'); await fs.mkdir(outside);
  const linked = path.join(dir, 'linked'); await fs.mkdir(linked); await fs.symlink(outside, path.join(linked, 'runtime'));
  await assert.rejects(installCloudflared(linked, dependencies), /符号链接/); assert.deepEqual(await fs.readdir(outside), []);
});

test('Darwin archive is verified before unpacking and executable is independently verified', { skip: process.platform === 'win32' }, async t => {
  const dir = await scratch(t);
  const source = path.join(dir, 'source'); await fs.mkdir(source);
  const bytes = Buffer.from(`#!/bin/sh\nprintf 'cloudflared version ${CLOUDFLARED_VERSION}\\n'\n`);
  await fs.writeFile(path.join(source, 'cloudflared'), bytes, { mode: 0o700 });
  const archive = path.join(dir, 'release.tgz'); execFileSync('tar', ['-czf', archive, '-C', source, 'cloudflared']);
  const compressed = await fs.readFile(archive);
  const release = { ...cloudflaredRelease('darwin', 'arm64'), hash: hash(compressed), binaryHash: hash(bytes), bytes: compressed.length };
  const deps = { release, fetch: async () => new Response(compressed) };
  assert.ok(await installCloudflared(path.join(dir, 'data'), deps));
  await assert.rejects(installCloudflared(path.join(dir, 'bad'), { ...deps, release: { ...release, binaryHash: '0'.repeat(64) } }), /完整性/);
});

test('GitHub asset redirects must remain on official release-assets host', async t => {
  const dir = await scratch(t);
  await assert.rejects(installCloudflared(dir, { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/file' } }) }), /非官方/);
  assert.deepEqual(await fs.readdir(path.join(dir, 'runtime')), []);
});

test('canceling a download removes its staging directory without running a client', async t => {
  const dir = await scratch(t), controller = new AbortController();
  let fetching;
  const started = new Promise(resolve => { fetching = resolve; });
  const installing = resolveCloudflared({ signal: controller.signal }, dir, {
    execute: async () => { throw new Error('no installed client'); },
    fetch: async (url, { signal }) => {
      fetching();
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await started;
  controller.abort();
  await assert.rejects(installing, { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(path.join(dir, 'runtime')), []);
});

async function fixture(t, { fail = false, registered = true, timeoutMs = 3000 } = {}) {
  const dir = await scratch(t);
  const log = path.join(dir, 'log.json'), pidFile = path.join(dir, 'pid'), script = path.join(dir, 'fixture.mjs');
  await fs.writeFile(script, `import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),env:Object.keys(process.env).filter(k=>/^(TUNNEL_|CLOUDFLARED_)/.test(k)),config:fs.readFileSync(process.argv[process.argv.indexOf('--config')+1],'utf8')}));
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    console.log('https://fixture-login.trycloudflare.com');
    ${registered ? "console.log('Registered tunnel connection');" : ''}
    ${fail ? 'process.exit(1);' : 'setInterval(()=>{},1000);'}
  `);
  const binary = path.join(dir, 'cloudflared');
  await fs.writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
  let tunnel;
  t.after(() => tunnel?.close());
  return { dir, log, pidFile, async open(options = {}) {
    tunnel = await createCloudflareTunnel('http://127.0.0.1:32100', { stateDir: dir, tunnelTimeoutMs: timeoutMs, ...options }, {
      resolve: async () => binary, pollMs: 10,
    });
    return tunnel;
  } };
}

test('login tunnel isolates named-tunnel configuration and cleans its worker and temporary files', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const before = process.env.TUNNEL_TOKEN; process.env.TUNNEL_TOKEN = 'do-not-use-existing-token';
  try {
    const tunnel = await f.open();
    assert.equal(tunnel.origin, 'https://fixture-login.trycloudflare.com');
    const log = JSON.parse(await fs.readFile(f.log));
    assert.deepEqual(log.env, []);
    assert.equal(log.config, '{}\n');
    assert.equal(log.args[log.args.indexOf('--url') + 1], 'http://127.0.0.1:32100');
    assert.ok(log.args.includes('--no-autoupdate'));
    assert.ok(!log.args.some(arg => ['login', 'service', '--token'].includes(arg)));
    const config = log.args[log.args.indexOf('--config') + 1];
    const pid = Number(await fs.readFile(f.pidFile));
    await Promise.all([tunnel.close(), tunnel.close()]);
    await assert.rejects(fs.stat(config), { code: 'ENOENT' });
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  } finally { if (before === undefined) delete process.env.TUNNEL_TOKEN; else process.env.TUNNEL_TOKEN = before; }
});

test('tunnel failure and readiness timeout clean up temporary configuration', { skip: process.platform === 'win32' }, async t => {
  for (const options of [{ fail: true, registered: false }, { registered: false, timeoutMs: 200 }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.open(), /启动失败|启动超时/);
    assert.deepEqual(await fs.readdir(path.join(f.dir, 'temporary')), []);
  }
});

test('login cancellation shuts down a ready tunnel and aborts pending startup', { skip: process.platform === 'win32' }, async t => {
  for (const registered of [true, false]) {
    const f = await fixture(t, { registered });
    const controller = new AbortController();
    const opening = f.open({ signal: controller.signal });
    if (registered) {
      const tunnel = await opening;
      controller.abort();
      await tunnel.close();
    } else {
      await until(() => syncFs.existsSync(f.pidFile));
      controller.abort();
      await assert.rejects(opening, { name: 'AbortError' });
    }
    assert.deepEqual(await fs.readdir(path.join(f.dir, 'temporary')), []);
    const pid = Number(await fs.readFile(f.pidFile));
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  }
});

test('cancellation during binary resolution cannot launch a tunnel and only loopback targets are allowed', async () => {
  const controller = new AbortController();
  let finish, launched = 0;
  const opening = createCloudflareTunnel('http://127.0.0.1:32100', { signal: controller.signal }, {
    resolve: () => new Promise(resolve => { finish = resolve; }), spawn: () => { launched++; },
  });
  controller.abort(); finish('/unused');
  await assert.rejects(opening, { name: 'AbortError' });
  assert.equal(launched, 0);
  for (const target of ['http://localhost:3000', 'https://example.com', 'http://127.0.0.1:3000/private']) {
    await assert.rejects(createCloudflareTunnel(target), /本机临时/);
  }
  for (const url of ['https://evil.invalid', 'https://fixture.trycloudflare.com.evil.invalid', 'https://fixture.trycloudflare.com:8443']) {
    assert.equal(quickTunnelOrigin(url), undefined);
  }
});

test('process supervision closes workers even when the owning host is killed', { skip: process.platform === 'win32' }, async t => {
  const dir = syncFs.mkdtempSync(path.join(os.tmpdir(), 'hf-tunnel-owner-'));
  const workerFile = path.join(dir, 'worker.pid');
  const supervisor = fileURLToPath(new URL('../src/owned-process.mjs', import.meta.url));
  const owner = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs'; import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, [${JSON.stringify(supervisor)}, String(process.pid), process.execPath, '-e', 'console.log(process.pid); setInterval(()=>{}, 1000);'], { stdio: ['pipe','pipe','ignore'] });
    child.stdout.on('data', data=>fs.writeFileSync(${JSON.stringify(workerFile)}, data.toString().trim()));
    setInterval(()=>{}, 1000);
  `], { stdio: 'ignore' });
  t.after(() => { owner.kill('SIGKILL'); syncFs.rmSync(dir, { recursive: true, force: true }); });
  await until(() => syncFs.existsSync(workerFile));
  const pid = Number(syncFs.readFileSync(workerFile, 'utf8')); assert.ok(pid > 0);
  owner.kill('SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
});

test('remote login detects SSH/headless Linux and respects an explicit local choice', () => {
  assert.equal(remoteLoginByDefault({}, {}, 'darwin'), false);
  assert.equal(remoteLoginByDefault({}, { SSH_CONNECTION: 'fixture' }, 'darwin'), true);
  assert.equal(remoteLoginByDefault({}, {}, 'linux'), true);
  assert.equal(remoteLoginByDefault({}, { DISPLAY: ':0' }, 'linux'), false);
  assert.equal(remoteLoginByDefault({ loginAccess: 'local' }, { SSH_TTY: 'fixture' }, 'linux'), false);
  assert.throws(() => remoteLoginByDefault({ loginAccess: 'bad' }), /loginAccess/);
});
