import ssh2 from 'ssh2';
import xterm from '@xterm/headless';
import { verifyHostKey } from './host-key.mjs';
import { BridgeError, MAX_REPLY_CHARS } from './protocol.mjs';

export class SshTerminal {
  constructor(options) {
    // HF's renderer wraps words itself, losing whitespace boundaries. A wide
    // virtual PTY fits even double-width Unicode in a bounded JSON reply.
    this.options = { cols: MAX_REPLY_CHARS * 2 + 192, rows: 64, host: 'chat.hf.co', port: 22, user: 'guest', ...options };
    this.terminal = new xterm.Terminal({
      cols: this.options.cols, rows: this.options.rows,
      scrollback: 5000, allowProposedApi: true,
    });
    this.queue = Promise.resolve();
    this.lastChange = Date.now();
    this.exited = false;
    this.closing = false;
    this.error = undefined;
    this.terminal.onData(data => this.send(data));
    // xterm does not answer background-color queries without a renderer.
    this.terminal.parser.registerOscHandler(11, data => {
      if (data === '?') this.send('\x1b]11;rgb:ffff/ffff/ffff\x07');
      return true;
    });
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => {
      this.send('\x1b[?0u');
      return true;
    });
    this.connection = new ssh2.Client();
    this.connection.on('error', error => { this.error ??= error; });
    this.connection.on('close', () => { this.exited = true; });
    this.connection.on('ready', () => {
      if (this.closing) return this.connection.destroy();
      this.connection.shell({
        term: 'xterm-256color', cols: this.options.cols, rows: this.options.rows,
        width: 0, height: 0,
      }, (error, channel) => {
        if (error) { this.error = error; this.connection.destroy(); return; }
        if (this.closing) { channel.destroy(); return; }
        this.channel = channel;
        const receive = chunk => {
          if (this.closing) return;
          const data = Uint8Array.from(chunk);
          this.options.onRaw?.(data);
          this.queue = this.queue.then(() => new Promise(resolve => {
            this.terminal.write(data, () => { this.lastChange = Date.now(); resolve(); });
          }));
        };
        channel.on('data', receive);
        channel.stderr.on('data', receive);
        channel.on('error', error => { this.error ??= error; });
        channel.on('close', () => { this.exited = true; this.connection.end(); });
      });
    });
    // Linked accounts reuse the plugin key saved by the host. Probes may still
    // use an ephemeral key. Neither a system SSH client nor ssh-keygen is used.
    // ssh2 1.17 strips leading zero bytes from Ed25519 public keys during
    // generation, occasionally producing malformed keys. ECDSA avoids that path.
    const privateKey = this.options.privateKey ?? ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'magpie-hf-ssh-anonymous' }).private;
    this.connection.connect({
      host: this.options.host, port: this.options.port, username: this.options.user,
      privateKey, authHandler: ['publickey'],
      readyTimeout: this.options.connectTimeoutMs ?? 15000,
      keepaliveInterval: 10000, keepaliveCountMax: 2,
      hostVerifier: (key, callback) => {
        verifyHostKey(this.options.stateDir, this.options.host, this.options.port, key).then(
          accepted => {
            if (!accepted) this.error = new Error('SSH host key changed; refusing the connection');
            callback(accepted && !this.closing);
          },
          error => { this.error = error; callback(false); },
        );
      },
    });
  }

  send(text) {
    if (!this.exited && !this.closing && this.channel?.writable) {
      this.channel.write(text);
    }
  }

  async screen() {
    await this.queue;
    const buffer = this.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      const next = buffer.getLine(i + 1);
      // A terminal wrap is not a newline in the model's JSON. Keep spaces
      // at wrap boundaries: trimming them can silently change file contents.
      // A wide character at the final column leaves an empty padding cell;
      // that cell is not an actual space in the JSON string.
      const padded = next?.isWrapped && next.getCell(0)?.getWidth() === 2 && line?.getCell(line.length - 1)?.getCode() === 0;
      let text = line?.translateToString(!next?.isWrapped, 0, padded ? line.length - 1 : undefined) ?? '';
      if (!next?.isWrapped) text = text.trimEnd();
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines.join('\n');
  }

  async waitFor(predicate, { timeout = 45000, signal } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const screen = await this.screen();
      // HF can show a login gate and the chat input at the same time. The
      // input alone does not mean this temporary key is allowed to chat.
      if (/^\s*(?:🤗\s*)?Your SSH key is not linked to a Hugging Face account\b/im.test(screen) ||
          (/https:\/\/(?:hf\.co|huggingface\.co)\/oauth\/device\b/i.test(screen) && /waiting for you to approve/i.test(screen))) {
        throw new BridgeError('Hugging Face requires this SSH key to be linked to an account. Sign in with the browser login method, then retry.', 403, 'hf_login_required');
      }
      if (predicate(screen)) return screen;
      if (this.error) throw this.error;
      if (this.exited) throw new Error(`SSH session closed: ${screen.trim().slice(-1000)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for the HF SSH terminal');
  }

  async ready(signal) {
    let entered = false;
    return this.waitFor(screen => {
      if (/Ask anything/i.test(screen)) return true;
      if (!entered && /start chatting/i.test(screen)) {
        this.send('\r');
        entered = true;
      }
      return false;
    }, { signal });
  }

  async paste(text, signal) {
    signal?.throwIfAborted();
    // Bracketed paste keeps newlines/control shortcuts out of the input handler.
    this.send('\x1b[200~' + text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') + '\x1b[201~');
    await new Promise(resolve => setTimeout(resolve, 300));
    signal?.throwIfAborted();
    this.send('\r');
  }

  disconnect() {
    this.closing = true;
    this.channel?.destroy();
    this.connection.destroy();
    this.exited = true;
  }

  async close() {
    this.disconnect();
    await this.queue;
    this.terminal.dispose();
  }
}
