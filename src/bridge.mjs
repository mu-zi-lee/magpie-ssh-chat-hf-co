import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ModelCatalog } from './models.mjs';
import { BridgeError, prepareRequest } from './protocol.mjs';
import { complete } from './transport.mjs';

export function errorResponse(error) {
  const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
  return Response.json({ error: {
    message: error.message ?? 'Unknown SSH bridge error',
    type: error.status >= 400 && error.status < 500 ? 'invalid_request_error' : 'server_error',
    code: typeof error.code === 'string' ? error.code : (aborted ? 'request_aborted' : 'ssh_bridge_error'),
  } }, { status: error.status ?? (aborted ? 504 : 502), ...(error.code === 'ssh_queue_full' ? { headers: { 'retry-after': '2' } } : {}) });
}

class SerialQueue {
  constructor(limit) { this.tail = Promise.resolve(); this.size = 0; this.limit = limit; }
  run(action, signal) {
    signal?.throwIfAborted();
    if (this.size >= this.limit) throw new BridgeError('SSH request queue is full; retry after the current requests finish', 503, 'ssh_queue_full');
    this.size++;
    const previous = this.tail;
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.tail = previous.then(() => current);
    return this.wait(action, signal, previous, release);
  }
  async wait(action, signal, previous, release) {
    let abort;
    try {
      signal?.throwIfAborted();
      const aborted = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
      });
      await Promise.race([previous, aborted]);
      signal?.throwIfAborted();
      return await action();
    } finally {
      signal?.removeEventListener('abort', abort);
      this.size--;
      release();
    }
  }
}

export function createBridge(options = {}, dependencies = {}) {
  const settings = { stateDir: resolve('.local/ssh'), ...options };
  const catalog = dependencies.catalog ?? new ModelCatalog(settings);
  const transport = dependencies.complete ?? complete;
  const maxQueuedRequests = settings.maxQueuedRequests ?? 8;
  if (!Number.isInteger(maxQueuedRequests) || maxQueuedRequests < 1) throw new Error('maxQueuedRequests must be a positive integer');
  const queue = new SerialQueue(maxQueuedRequests);

  function execute(request, signal) {
    return queue.run(async () => {
      const privateKey = settings.getPrivateKey ? await settings.getPrivateKey() : settings.privateKey;
      signal.throwIfAborted();
      return transport(request, { ...settings, privateKey }, signal);
    }, signal);
  }

  return {
    catalog,
    async fetch(input, init) {
      try {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname.replace(/\/$/, '');
        if (path === '/health' && request.method === 'GET') {
          return Response.json({ ok: true, transport: 'ssh-pty', tools: 'experimental_json' });
        }
        if (path.endsWith('/models') && request.method === 'GET') {
          const models = await catalog.list();
          return Response.json({ object: 'list', data: models.data, catalog_source: models.source, catalog_stale: models.stale, ...(models.error ? { catalog_error: models.error } : {}) });
        }
        if (!path.endsWith('/chat/completions')) return errorResponse(new BridgeError('Unknown endpoint', 404, 'not_found'));
        if (request.method !== 'POST') return errorResponse(new BridgeError('Use POST for chat completions', 405));
        const raw = await request.text();
        if (raw.length > (settings.maxBodyChars ?? 250000)) throw new BridgeError('Request body is too large', 413);
        let body;
        try { body = JSON.parse(raw); }
        catch { throw new BridgeError('Invalid request JSON', 400, 'invalid_request_error'); }
        const prepared = prepareRequest(body, settings);
        const controlHeaders = {
          ...(prepared.ignoredParameters.length ? { 'x-hf-ssh-ignored-parameters': prepared.ignoredParameters.join(',') } : {}),
          ...(prepared.tokenTarget ? { 'x-hf-ssh-soft-token-limit': String(prepared.tokenTarget) } : {}),
        };
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(settings.requestTimeoutMs ?? 210000)]);
        // Reserve the queue slot before opening SSE so overload gets a real HTTP 503.
        const work = execute(prepared, signal);
        // The stream consumes this promise asynchronously; observe rejection now.
        work.catch(() => {});
        const id = 'chatcmpl-' + randomUUID().replaceAll('-', '');
        const created = Math.floor(Date.now() / 1000);
        const base = { id, created, model: body.model };
        if (!body.stream) {
          const message = await work;
          return Response.json({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }, { headers: controlHeaders });
        }
        const encoder = new TextEncoder();
        let closed = false;
        const stream = new ReadableStream({
          async start(streamController) {
            const send = text => { if (!closed) streamController.enqueue(encoder.encode(text)); };
            const event = delta => send(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
            const heartbeat = setInterval(() => send(': waiting for SSH model\n\n'), 2000);
            try {
              send(': waiting for SSH model\n\n');
              const message = await work;
              // Buffer until validation; incomplete JSON must never reach a tool executor.
              event({ role: 'assistant' });
              if (message.content) event({ content: message.content });
              if (message.tool_calls) event({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) });
              send(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] })}\n\n`);
            } catch (error) {
              send(`data: ${JSON.stringify(await errorResponse(error).json())}\n\n`);
            } finally {
              clearInterval(heartbeat);
              if (!closed) { send('data: [DONE]\n\n'); closed = true; streamController.close(); }
            }
          },
          cancel() { closed = true; controller.abort(); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', ...controlHeaders } });
      } catch (error) { return errorResponse(error); }
    },
  };
}
