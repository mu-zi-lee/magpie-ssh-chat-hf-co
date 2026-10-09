import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MODEL } from '../src/protocol.mjs';

const port = 15695;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
  env: { ...process.env, MAGPIE_HF_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', chunk => { stderr += chunk; });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP server startup timeout')), 5000);
    server.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
  });
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.ok, true);
  const catalog = await (await fetch(`${base}/v1/models`)).json();
  assert.ok(catalog.data.length > 1);
  assert.equal(catalog.data.filter(model => model.ssh_available).length, 1);
  console.log(`PASS HTTP /v1/models: ${catalog.data.length} models, access explicitly labeled`);
  const locked = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: 'other/model', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(locked.status, 403);
  assert.equal((await locked.json()).error.code, 'hf_login_required');
  console.log('PASS unavailable models return 403 hf_login_required');
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer anonymous' },
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [{ role: 'user', content: 'Call read_file for package.json.' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }],
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    }),
    signal: AbortSignal.timeout(180000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  const chunks = text.split('\n\n').filter(event => event.startsWith('data: ') && !event.includes('[DONE]')).map(event => JSON.parse(event.slice(6)));
  assert.ok(chunks.every(chunk => !chunk.error), JSON.stringify(chunks));
  const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? []);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'package.json' });
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  console.log('PASS real HTTP SSE: validated read_file call, tool_calls finish reason and [DONE]');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
