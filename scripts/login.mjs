import { resolve } from 'node:path';
import { authorizeSsh, saveLocalAuth } from '../src/auth.mjs';

const stateDir = resolve('.local/ssh');
const controller = new AbortController();
const cancel = () => controller.abort(new DOMException('Login canceled', 'AbortError'));
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const access = process.argv.slice(2);
  if (access.some(arg => !['--cloudflare', '--local'].includes(arg)) || access.length > 1) {
    throw new Error('用法：login.mjs [--cloudflare | --local]');
  }
  const loginAccess = access.includes('--cloudflare') ? 'cloudflare' : access.includes('--local') ? 'local' : 'auto';
  const login = await authorizeSsh({ stateDir, signal: controller.signal, loginAccess });
  console.log(`登录链接：${login.url}\n${login.instructions}`);
  const result = await login.callback();
  if (result.type !== 'success') throw new Error(result.error);
  await saveLocalAuth(stateDir, result);
  console.log(`已登录 ${result.metadata.email}。SSH 密钥已保存，后续请求会复用此密钥。`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
