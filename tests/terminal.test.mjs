import test from 'node:test';
import assert from 'node:assert/strict';
import ssh2 from 'ssh2';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshTerminal } from '../src/terminal.mjs';

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
    assert.equal(ptyInfo.cols, 240);
    assert.equal(ptyInfo.rows, 240);
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
