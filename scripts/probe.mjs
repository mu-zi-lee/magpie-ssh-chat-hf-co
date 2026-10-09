import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SshTerminal } from '../src/terminal.mjs';

const stateDir = resolve('.local/ssh');
const out = resolve('.local/probe');
await mkdir(out, { recursive: true });
const raw = [];
const terminal = new SshTerminal({ stateDir, onRaw: data => raw.push(Buffer.from(data)) });
const report = { at: new Date().toISOString(), host: 'chat.hf.co', pty: true, nativeToolCalling: 'unverified' };
try {
  report.readyScreen = (await terminal.ready()).trim();
  console.log(report.readyScreen);
  if (process.argv.includes('--help-menu')) {
    await terminal.paste('/help');
    await new Promise(resolve => setTimeout(resolve, 2000));
    report.helpScreen = (await terminal.screen()).trim();
    console.log(report.helpScreen);
  }
  if (process.argv.includes('--models')) {
    await terminal.paste('/model');
    await new Promise(resolve => setTimeout(resolve, 2000));
    report.modelScreen = (await terminal.screen()).trim();
    console.log(report.modelScreen.split('\n').filter(line => line.trim()).join('\n'));
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  report.screen = (await terminal.screen()).trim();
  console.error(report.error, report.screen);
  process.exitCode = 1;
} finally {
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(out, 'terminal.bin'), Buffer.concat(raw));
  await terminal.close();
  console.log('Saved diagnostic output in .local/probe (not tracked by Git)');
}
