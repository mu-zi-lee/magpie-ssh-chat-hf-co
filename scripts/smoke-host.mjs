// Developer integration check against Magpie's official standalone Bun host.
// No login RPC and no executable in PATH are allowed in the child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MODEL } from '../src/protocol.mjs';

const [hostPath, pluginPath = process.cwd()] = process.argv.slice(2);
if (!hostPath) throw new Error('Developer usage: bun scripts/smoke-host.mjs /path/to/magpie/internal/plugin/host.js [installed-plugin-directory]');
const directory = await mkdtemp(join(tmpdir(), 'magpie-hf-automatic-'));
const child = spawn(process.execPath, [resolve(hostPath)], {
  env: { ...process.env, PATH: '' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let id = 0;
let stderr = '';
const pending = new Map();
const lines = createInterface({ input: child.stdout });
child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
function failAll(error) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
}
child.on('error', failAll);
child.on('exit', code => failAll(new Error(`Host exited ${code}: ${stderr}`)));
lines.on('line', line => {
  try {
    const event = JSON.parse(line);
    const item = pending.get(event.id);
    if (!item) return;
    if (event.event) { item.events.push(event); return; }
    clearTimeout(item.timer);
    pending.delete(event.id);
    if (event.error) item.reject(new Error(event.error.message));
    else item.resolve({ result: event.result, events: item.events });
  } catch (error) { failAll(error); }
});
function rpc(method, params) {
  const requestId = ++id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Host timeout: ${method}`));
    }, 180000);
    pending.set(requestId, { resolve, reject, timer, events: [] });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
  });
}

try {
  const authPath = join(directory, 'plugin-auth.json');
  // Verify that automatic setup does not erase another provider's credentials.
  await writeFile(authPath, JSON.stringify({ 'unrelated-test': { type: 'api', key: 'preserve-me' } }));
  const { result } = await rpc('init', {
    directory, authPath,
    plugins: [{ spec: resolve(pluginPath), target: resolve(pluginPath) }],
  });
  assert.ok(!result.plugins[0].error, result.plugins[0].error);
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  assert.equal(auth['hf-ssh'].key, 'anonymous');
  assert.equal(auth['unrelated-test'].key, 'preserve-me');
  const providers = (await rpc('providers', {})).result;
  assert.equal(providers[0].signedIn, true);
  assert.equal(providers[0].models[0].id, MODEL);
  console.log('PASS official Magpie host: automatically connected account, no login RPC, no tools in PATH');
  const response = await rpc('fetch', {
    provider: 'hf-ssh', model: MODEL, npm: '@ai-sdk/openai-compatible',
    url: 'http://127.0.0.1/hf-ssh/v1/chat/completions', method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say exactly AUTO_SETUP_OK.' }], stream: true, max_tokens: 100, temperature: 0.7 })).toString('base64'),
  });
  assert.equal(response.events.find(event => event.event === 'head').status, 200);
  const text = response.events.filter(event => event.event === 'chunk').map(event => Buffer.from(event.data, 'base64').toString()).join('');
  assert.ok(text.includes('AUTO_SETUP_OK'), text);
  assert.ok(text.includes('data: [DONE]'), text);
  assert.ok(!text.includes('"error"'), text);
  console.log('PASS real HF reply through the official Bun host with only the plugin installed');
} finally {
  child.kill('SIGTERM');
  lines.close();
  failAll(new Error('Integration test finished'));
  await new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await rm(directory, { recursive: true, force: true });
}
