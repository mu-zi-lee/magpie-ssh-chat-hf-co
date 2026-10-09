import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createBridge } from '../src/bridge.mjs';
import { MODEL } from '../src/protocol.mjs';

const bridge = createBridge({ stateDir: resolve('.local/ssh') });
const reports = [];
async function chat(body) {
  const started = Date.now();
  const response = await bridge.fetch('http://localhost/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: MODEL, ...body }),
  });
  const value = await response.json();
  reports.push({ status: response.status, elapsedMs: Date.now() - started, value });
  assert.equal(response.status, 200, JSON.stringify(value));
  return value.choices[0].message;
}

try {
  const models = await (await bridge.fetch('http://localhost/v1/models')).json();
  console.log(`Discovered ${models.data.length} models; anonymous SSH available: ${models.data.filter(m => m.ssh_available).length}`);
  const tools = [{ type: 'function', function: {
    name: 'read_file', description: 'Read the contents of a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  } }];
  const messages = [{ role: 'user', content: 'Read package.json with read_file, then tell me its package name. Do not guess the file contents.' }];
  const first = await chat({ messages, tools, tool_choice: { type: 'function', function: { name: 'read_file' } }, parallel_tool_calls: false });
  assert.equal(first.tool_calls?.length, 1);
  assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { path: 'package.json' });
  console.log('PASS: structured read_file request (experimental JSON compatibility)');
  // Supply a synthetic result; no model-generated instruction is executed by this test.
  const second = await chat({ messages: [...messages, first, {
    role: 'tool', tool_call_id: first.tool_calls[0].id,
    content: '{"name":"magpie-ssh-smoke-fixture"}',
  }], tools, tool_choice: 'none' });
  assert.ok(second.content.includes('magpie-ssh-smoke-fixture'));
  console.log('PASS: result associated with tool_call_id and final answer:', second.content);
  reports.push({ models: models.data.length, catalogStale: models.catalog_stale, ok: true });
} catch (error) {
  reports.push({ ok: false, error: error.message });
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir('.local', { recursive: true });
  await writeFile('.local/smoke.json', JSON.stringify(reports, null, 2));
}
