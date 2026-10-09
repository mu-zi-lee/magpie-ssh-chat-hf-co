import { SshTerminal } from './terminal.mjs';
import { assistantArea, parseReply, BridgeError } from './protocol.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const transient = error => ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code) || /^(Timed out|SSH session closed)|handshake.*timeout/i.test(error.message);

export async function complete(request, options, signal, { Terminal = SshTerminal } = {}) {
  const retries = options.connectRetries ?? 1;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new BridgeError('connectRetries must be an integer from 0 to 2', 400, 'invalid_request_error');
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    let terminal, dispatched = false, retry = false;
    const abort = () => terminal?.disconnect();
    try {
      terminal = new Terminal(options);
      signal?.addEventListener('abort', abort, { once: true });
      signal?.throwIfAborted();
      await terminal.ready(signal);
      // Even a partial paste may have reached HF. Never replay after this point.
      dispatched = true;
      await terminal.paste(request.prompt, signal);
      let reply = '';
      await terminal.waitFor(screen => {
        reply = assistantArea(screen);
        return reply.includes(request.end) && /┃ Ask anything/i.test(screen) && Date.now() - terminal.lastChange > 800;
      }, { timeout: options.timeoutMs ?? 150000, signal });
      return parseReply(reply, request);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof BridgeError) throw error;
      retry = !dispatched && attempt < retries && transient(error);
      if (!retry) {
        const timedOut = /timed? out|timeout/i.test(error.message);
        const code = timedOut ? (dispatched ? 'ssh_response_timeout' : 'ssh_connect_timeout') : (dispatched ? 'ssh_session_lost' : 'ssh_connection_failed');
        throw new BridgeError(error.message, timedOut ? 504 : 502, code);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      await terminal?.close();
    }
    if (retry) await delay(250 * (attempt + 1), undefined, { signal });
  }
}
