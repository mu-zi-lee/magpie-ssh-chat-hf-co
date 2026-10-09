import { SshTerminal } from './terminal.mjs';
import { assistantArea, parseReply, BridgeError } from './protocol.mjs';

export async function complete(request, options, signal) {
  const terminal = new SshTerminal(options);
  const abort = () => terminal.process.kill('SIGTERM');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await terminal.ready(signal);
    await terminal.paste(request.prompt, signal);
    let reply = '';
    await terminal.waitFor(screen => {
      reply = assistantArea(screen);
      // A complete envelope plus idle terminal is required, never silence alone.
      return reply.includes(request.end) && /┃ Ask anything/i.test(screen) && Date.now() - terminal.lastChange > 800;
    }, { timeout: options.timeoutMs ?? 150000, signal });
    return parseReply(reply, request);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(error.message, /Timed out/.test(error.message) ? 504 : 502);
  } finally {
    signal?.removeEventListener('abort', abort);
    await terminal.close();
  }
}
