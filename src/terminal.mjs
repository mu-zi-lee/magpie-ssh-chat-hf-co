import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';

export class SshTerminal {
  constructor(options) {
    this.options = { cols: 240, rows: 240, python: 'python3', ...options };
    this.terminal = new xterm.Terminal({
      cols: this.options.cols, rows: this.options.rows,
      scrollback: 5000, allowProposedApi: true,
    });
    this.queue = Promise.resolve();
    this.lastChange = Date.now();
    this.exited = false;
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
    this.process = spawn(this.options.python,
      ['-u', fileURLToPath(new URL('./pty_worker.py', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    this.process.on('error', error => { this.error = error; this.exited = true; });
    this.process.on('close', () => { this.exited = true; });
    this.process.stdin.on('error', () => {});
    let stderr = '';
    this.process.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
    this.process.on('close', code => {
      if (code && !this.error) this.error = new Error(`PTY worker exited (${code}): ${stderr}`);
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.error) this.error = new Error(event.error);
        if (event.data) {
          const data = Uint8Array.from(Buffer.from(event.data, 'base64'));
          this.options.onRaw?.(data);
          this.queue = this.queue.then(() => new Promise(resolve => {
            this.terminal.write(data, () => { this.lastChange = Date.now(); resolve(); });
          }));
        }
      } catch (error) { this.error = error; }
    });
    this.process.stdin.write(JSON.stringify(this.options) + '\n');
  }

  send(text) {
    if (!this.exited && !this.process.stdin.destroyed) {
      this.process.stdin.write(JSON.stringify({ data: Buffer.from(text).toString('base64') }) + '\n');
    }
  }

  async screen() {
    await this.queue;
    const buffer = this.terminal.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push((buffer.getLine(i)?.translateToString(true) ?? '').trimEnd());
    }
    return lines.join('\n');
  }

  async waitFor(predicate, { timeout = 45000, signal } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const screen = await this.screen();
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

  async close() {
    if (!this.exited) {
      this.process.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2500);
        this.process.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (!this.exited) this.process.kill('SIGKILL');
    await this.queue;
    this.lines.close();
    this.terminal.dispose();
  }
}
