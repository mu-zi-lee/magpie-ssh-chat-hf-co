import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../src/bridge.mjs';
import { ModelCatalog, normalizeCatalog } from '../src/models.mjs';
import { BridgeError, MODEL } from '../src/protocol.mjs';
import { HuggingFaceSshPlugin } from '../index.mjs';

const request = (bridge, body = {}) => bridge.fetch('http://localhost/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...body }) });

test('HF login refusal reaches JSON and SSE clients and releases the queue', async () => {
  const bridge = createBridge({ maxQueuedRequests: 1 }, { complete: async () => {
    throw new BridgeError('HF login required', 403, 'hf_login_required');
  } });
  const response = await request(bridge);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'hf_login_required');
  const text = await (await request(bridge, { stream: true })).text();
  assert.match(text, /"code":"hf_login_required"/);
  assert.ok(!text.includes('"finish_reason":"stop"'));
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.equal((await request(bridge)).status, 403);
});

test('upstream credit exhaustion reaches JSON and SSE clients without a timeout', async () => {
  const bridge = createBridge({}, { complete: async () => {
    throw new BridgeError('HF SSH: You have no remaining credits.', 402, 'hf_insufficient_credits');
  } });
  const response = await request(bridge);
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error.code, 'hf_insufficient_credits');
  const sse = await (await request(bridge, { stream: true })).text();
  assert.match(sse, /"code":"hf_insufficient_credits"/);
  assert.ok(!sse.includes('"role":"assistant"'));
  assert.ok(!sse.includes('"finish_reason":"stop"'));
});

test('OpenAI JSON and SSE retain tool call identifiers and finish_reason', async () => {
  const message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] };
  const bridge = createBridge({}, { complete: async () => message });
  const json = await (await request(bridge)).json();
  assert.equal(json.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(json.choices[0].message, message);
  const response = await request(bridge, { stream: true });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const sse = await response.text();
  const chunks = sse.split('\n\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
  assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, 'call_1');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.ok(sse.endsWith('data: [DONE]\n\n'));
});

test('SSH requests are serialized even when the client sends them concurrently', async () => {
  let active = 0, peak = 0;
  const bridge = createBridge({}, { complete: async () => {
    active++; peak = Math.max(active, peak);
    await new Promise(resolve => setTimeout(resolve, 20));
    active--; return { role: 'assistant', content: 'hi' };
  } });
  await Promise.all([request(bridge), request(bridge), request(bridge)]);
  assert.equal(peak, 1);
});

test('JSON and SSE responses disclose unsupported sampling defaults and soft token targets', async () => {
  const bridge = createBridge({}, { complete: async () => ({ role: 'assistant', content: 'hi' }) });
  for (const stream of [false, true]) {
    const response = await request(bridge, { temperature: 0.7, max_tokens: 50, stream });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-hf-ssh-ignored-parameters'), 'temperature');
    assert.equal(response.headers.get('x-hf-ssh-soft-token-limit'), '50');
    await response.text();
  }
});

test('canceling an SSE consumer aborts its transport', async () => {
  let aborted = false;
  const bridge = createBridge({}, { complete: async (_, __, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  const response = await request(bridge, { stream: true });
  const reader = response.body.getReader();
  await reader.read();
  await new Promise(resolve => setTimeout(resolve, 10));
  await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(aborted, true);
});

test('catalog returns all models with explicit access and handles refresh failure', async () => {
  const all = normalizeCatalog([{ id: MODEL }, { id: 'other/model' }, { id: 'other/model' }]);
  assert.equal(all.length, 2);
  assert.equal(all[1].ssh_available, false);
  let fails = false;
  const catalog = new ModelCatalog({ fetcher: async () => {
    if (fails) throw new Error('offline');
    return Response.json({ data: [{ id: MODEL }, { id: 'other/model' }] });
  } });
  assert.equal((await catalog.list()).data.length, 2);
  fails = true;
  const stale = await catalog.list({ refresh: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.data.length, 2);
  const bridge = createBridge({}, { catalog });
  const response = await bridge.fetch('http://localhost/v1/models');
  assert.equal((await response.json()).data.length, 2);
});

test('queue overload returns HTTP 503 for JSON and SSE; canceled waiters never run', async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const running = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const bridge = createBridge({ maxQueuedRequests: 2 }, { complete: async () => {
    calls++;
    if (calls === 1) { started(); await running; }
    return { role: 'assistant', content: 'ok' };
  } });
  const first = request(bridge);
  await entered;
  const controller = new AbortController();
  const second = bridge.fetch('http://localhost/v1/chat/completions', { method: 'POST', signal: controller.signal,
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'queued' }], stream: true }) });
  const queuedResponse = await second;
  for (const stream of [false, true]) {
    const response = await request(bridge, { stream });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.equal((await response.json()).error.code, 'ssh_queue_full');
  }
  controller.abort();
  await queuedResponse.text();
  const third = request(bridge);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await third).status, 200);
  assert.equal(calls, 2);
});

test('offline catalog uses a retry cooldown while preserving access and billing labels', async () => {
  let calls = 0;
  const catalog = new ModelCatalog({ fetcher: async () => { calls++; throw new Error('offline'); } });
  const results = await Promise.all([catalog.list(), catalog.list(), catalog.list()]);
  assert.equal(calls, 1);
  assert.equal((await catalog.list()).stale, true);
  assert.equal(calls, 1);
  assert.equal(results[0].data[0].ssh_billing, 'unverified');
  assert.equal(results[0].data[0].ssh_access, 'linked_hf_account');
  const models = normalizeCatalog([{ id: MODEL }, { id: 'other/model', providers: [{ is_free: true }] }]);
  assert.equal(models[1].ssh_available, false);
  assert.equal(models[1].ssh_billing, 'unverified');
  await catalog.list({ refresh: true });
  assert.equal(calls, 2);
});

test('timed-out work releases the queue and JSON/SSE report the same abort code', async () => {
  const bridge = createBridge({ requestTimeoutMs: 50, maxQueuedRequests: 1 }, { complete: async (_, __, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  // Node's AbortSignal.timeout timer is unref'ed; hold the event loop for this test.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const response = await request(bridge);
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, 'request_aborted');
    const sse = await (await request(bridge, { stream: true })).text();
    assert.match(sse, /"code":"request_aborted"/);
    assert.ok(sse.endsWith('data: [DONE]\n\n'));
  } finally { clearInterval(keepAlive); }
});

test('plugin has one function export, preserves configuration and exposes browser authentication', async () => {
  const exported = await import('../index.mjs');
  assert.equal(Object.values(exported).filter(item => typeof item === 'function').length, 1);
  const hooks = await HuggingFaceSshPlugin({ directory: '/tmp' });
  const config = { provider: { 'hf-ssh': { name: 'User settings' } } };
  await hooks.config(config);
  assert.equal(config.provider['hf-ssh'].name, 'User settings');
  assert.equal(hooks.auth.methods[0].type, 'oauth');
  const loader = await hooks.auth.loader(async () => ({ type: 'api', key: 'anonymous' }));
  assert.equal(typeof loader.fetch, 'function');
});
