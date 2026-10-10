import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshTerminal } from '../src/terminal.mjs';
import xterm from '@xterm/headless';
import { MODEL, prepareRequest, parseReply, assistantArea } from '../src/protocol.mjs';

test('HF login gates fail before the visible chat input is accepted as ready', async () => {
  for (const gate of [
    '🤗 Your SSH key is not linked to a Hugging Face account, log in below to chat with it.',
    'open https://hf.co/oauth/device and enter\nABCD-EFGH\n⣷ waiting for you to approve',
  ]) {
    const terminal = {
      screen: async () => `🤗 ssh chat ${MODEL}\n${gate}\n┃ Ask anything...`,
      send: () => assert.fail('Login must fail without submitting input'),
      waitFor: SshTerminal.prototype.waitFor,
    };
    await assert.rejects(SshTerminal.prototype.ready.call(terminal), {
      status: 403, code: 'hf_login_required',
    });
  }
  const terminal = {
    screen: async () => `🤗 ssh chat ${MODEL} @anonymous\nHi! You are chatting anonymously.\nType /login to use your Hugging Face account.\n┃ Ask anything...`,
    waitFor: SshTerminal.prototype.waitFor,
  };
  assert.match(await SshTerminal.prototype.ready.call(terminal), /@anonymous/);
});

test('wrapped terminal JSON preserves Unicode, spaces and escaped file newlines', async () => {
  const request = prepareRequest({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] });
  const content = 'hello  世界    '.repeat(25) + '\nnext line\t"quoted"\\path';
  const json = JSON.stringify({ content, tool_calls: [] });
  const terminal = new xterm.Terminal({ cols: 32, rows: 40, allowProposedApi: true });
  try {
    await new Promise(resolve => terminal.write(`🤗 ${MODEL}\r\n${request.start}\r\n${json}\r\n${request.end}\r\n┃ Ask anything`, resolve));
    const screen = await SshTerminal.prototype.screen.call({ queue: Promise.resolve(), terminal });
    assert.equal(parseReply(assistantArea(screen), request).content, content);
  } finally { terminal.dispose(); }
});

test('JavaScript SSH allocates the remote PTY, responds to terminal queries and cancels cleanly', { timeout: 10000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hf-ssh-terminal-'));
  const key = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
  const sockets = new Set();
  const responses = [];
  let ptyInfo;
  const server = new ssh2.Server({ hostKeys: [key.private] }, client => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    client.on('authentication', context => {
      if (context.method === 'publickey') context.accept();
      else context.reject(['publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('pty', (accept, _, info) => { ptyInfo = info; accept(); });
      session.on('shell', accept => {
        const channel = accept();
        channel.on('data', data => {
          responses.push(data.toString());
          if (responses.join('').includes('\x1b]11;rgb:ffff/ffff/ffff\x07')) channel.write('\x1b[2J\x1b[H┃ Ask anything');
        });
        channel.write('\x1b]11;');
        setTimeout(() => channel.write('?\x07\x1b[c'), 20);
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const terminal = new SshTerminal({ stateDir, host: '127.0.0.1', port: server.address().port });
  try {
    assert.match(await terminal.ready(), /Ask anything/);
    assert.equal(ptyInfo.term, 'xterm-256color');
    assert.ok(ptyInfo.cols >= 8000);
    assert.equal(ptyInfo.rows, 64);
    assert.ok(responses.join('').includes('\x1b]11;rgb:ffff/ffff/ffff\x07'));
    terminal.disconnect();
    assert.equal(terminal.exited, true);
  } finally {
    await terminal.close();
    for (const socket of sockets) socket.end();
    await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
