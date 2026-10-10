import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createBridge } from './src/bridge.mjs';
import { MODEL } from './src/protocol.mjs';
import { magpieModel } from './src/models.mjs';
import { authorizeSsh, privateKeyFromAuth } from './src/auth.mjs';

const PROVIDER = 'hf-ssh';
const BASE = 'http://127.0.0.1/hf-ssh/v1';
const ICON = `data:image/webp;base64,${readFileSync(new URL('./assets/icon.webp', import.meta.url)).toString('base64')}`;

export const HuggingFaceSshPlugin = async (input = {}, options = {}) => {
  const settings = {
    ...options,
    stateDir: options.stateDir ?? resolve(input.directory ?? process.cwd(), 'hf-ssh-state'),
  };
  const bridge = createBridge(settings);
  return {
    async config(config) {
      config.provider ??= {};
      config.provider[PROVIDER] ??= {
        name: 'Hugging Face SSH Chat (experimental)',
        npm: '@ai-sdk/openai-compatible',
        api: BASE,
        models: { [MODEL]: magpieModel({ id: MODEL, ssh_available: true }) },
      };
    },
    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 1,
      methods: [{
        type: 'oauth',
        label: 'Hugging Face 浏览器登录（链接认证）',
        authorize: () => authorizeSsh(settings),
      }, {
        type: 'oauth',
        label: 'Hugging Face 远程登录（Cloudflare 临时通道）',
        authorize: () => authorizeSsh({ ...settings, loginAccess: 'cloudflare' }),
      }, {
        type: 'oauth',
        label: 'Hugging Face 本机登录（本地页面）',
        authorize: () => authorizeSsh({ ...settings, loginAccess: 'local' }),
      }],
      async loader(getAuth) {
        const accountBridge = createBridge({ ...settings, getPrivateKey: async () => privateKeyFromAuth(await getAuth()) });
        // The stored credential is an SSH private key, never an HTTP API key.
        return { baseURL: BASE, apiKey: 'hf-ssh', fetch: accountBridge.fetch };
      },
      async usage() {
        return { plan: 'HF SSH account', windows: [], error: 'HF SSH does not expose account quota or billing; check Hugging Face for limits and costs.' };
      },
    },
    provider: {
      id: PROVIDER,
      async models(provider) {
        const catalog = await bridge.catalog.list();
        // The complete catalog is exposed by /v1/models. Only verified SSH-accessible
        // models enter the active Magpie pool, so agents cannot route to locked models.
        const base = provider.models[MODEL];
        if (!base) return provider.models;
        const result = Object.fromEntries(catalog.data.filter(model => model.ssh_available).map(model => [model.id, {
          ...base, id: model.id, name: `${model.id} (SSH · experimental tools)`,
        }]));
        if (catalog.stale) result[Symbol.for('magpie.fellBack')] = true;
        return result;
      },
    },
  };
};
