import { resolve } from 'node:path';
import { createBridge } from './src/bridge.mjs';
import { MODEL } from './src/protocol.mjs';
import { magpieModel } from './src/models.mjs';

const PROVIDER = 'hf-ssh';
const BASE = 'http://127.0.0.1/hf-ssh/v1';

export const HuggingFaceSshPlugin = async (input = {}, options = {}) => {
  const bridge = createBridge({
    ...options,
    stateDir: options.stateDir ?? resolve(input.directory ?? process.cwd(), 'hf-ssh-state'),
  });
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
      maxConcurrency: 1,
      methods: [{
        type: 'api',
        label: 'Anonymous SSH (enter anonymous; no HF API key)',
        placeholder: 'anonymous',
        async authorize() {
          return { type: 'success', key: 'anonymous', metadata: { email: '@anonymous' } };
        },
      }],
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== 'api') return {};
        return { baseURL: BASE, apiKey: 'anonymous', fetch: bridge.fetch };
      },
      async usage() {
        return { plan: 'Anonymous SSH', windows: [], error: 'Upstream does not expose quota; unlimited usage is not verified.' };
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
