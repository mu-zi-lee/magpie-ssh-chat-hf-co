import test from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../src/transport.mjs';
import { MODEL, prepareRequest } from '../src/protocol.mjs';

const request = () => prepareRequest({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] });
const disconnected = () => Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });

test('a dropped connection before dispatch reconnects and sends the prompt once', async () => {
  const req = request();
  let connections = 0, sent = 0, closed = 0;
  class Terminal {
    constructor() { this.number = ++connections; this.lastChange = 0; }
    async ready() { if (this.number === 1) throw disconnected(); }
    async paste() { sent++; }
    async waitFor(predicate) {
      const screen = `🤗 ${MODEL}\n${req.start}\n{"content":"ok","tool_calls":[]}\n${req.end}\n┃ Ask anything`;
      assert.ok(predicate(screen));
    }
    async close() { closed++; }
  }
  assert.equal((await complete(req, {}, undefined, { Terminal })).content, 'ok');
  assert.equal(connections, 2);
  assert.equal(sent, 1);
  assert.equal(closed, 2);
});

test('a dropped connection during paste or reply never replays a prompt', async () => {
  for (const failDuringPaste of [true, false]) {
    let connections = 0, sent = 0, closed = 0;
    class Terminal {
      constructor() { connections++; }
      async ready() {}
      async paste() { sent++; if (failDuringPaste) throw disconnected(); }
      async waitFor() { throw disconnected(); }
      async close() { closed++; }
    }
    await assert.rejects(complete(request(), {}, undefined, { Terminal }), { code: 'ssh_session_lost' });
    assert.equal(connections, 1);
    assert.equal(sent, 1);
    assert.equal(closed, 1);
  }
});

test('host identity failures are never retried and cancellation interrupts reconnect backoff', async () => {
  let connections = 0;
  class RejectedHost {
    constructor() { connections++; }
    async ready() { throw new Error('SSH host key changed; refusing the connection'); }
    async close() {}
  }
  await assert.rejects(complete(request(), {}, undefined, { Terminal: RejectedHost }), /host key changed/);
  assert.equal(connections, 1);
  const controller = new AbortController();
  class Disconnected {
    constructor() { connections++; }
    async ready() { throw disconnected(); }
    async close() { controller.abort(); }
  }
  await assert.rejects(complete(request(), {}, controller.signal, { Terminal: Disconnected }), { name: 'AbortError' });
  assert.equal(connections, 2);
});
