import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { createBridge, errorResponse } from '../src/bridge.mjs';
import { BridgeError } from '../src/protocol.mjs';

const port = Number(process.env.MAGPIE_HF_PORT ?? 5695);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MAGPIE_HF_PORT');
const bridge = createBridge({ stateDir: resolve('.local/ssh') });
const server = createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  incoming.on('aborted', () => controller.abort());
  outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > 1000000) throw new BridgeError('Request body is too large', 413);
      chunks.push(chunk);
    }
    const response = await bridge.fetch(`http://127.0.0.1:${port}${incoming.url}`, {
      method: incoming.method, headers: incoming.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: controller.signal,
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(outgoing);
    else outgoing.end();
  } catch (error) {
    const response = errorResponse(error);
    if (!outgoing.headersSent) outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  }
});
server.listen(port, '127.0.0.1', () => console.log(`HF SSH bridge: http://127.0.0.1:${port}/v1 (experimental JSON tools)`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  server.close();
  server.closeAllConnections();
});
