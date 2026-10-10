import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL, BridgeError } from './protocol.mjs';

export const CATALOG_URL = 'https://router.huggingface.co/v1/models';
const fallback = { id: MODEL, object: 'model', created: 0, owned_by: 'Qwen' };

export function normalizeCatalog(data) {
  if (!Array.isArray(data) || !data.length) throw new BridgeError('Empty Hugging Face model catalog');
  const unique = new Map();
  for (const model of data) {
    if (typeof model?.id !== 'string' || !model.id) continue;
    unique.set(model.id, {
      ...model, object: 'model',
      ssh_available: model.id === MODEL,
      ssh_access: model.id === MODEL ? 'linked_hf_account' : 'unsupported_unverified',
      ssh_tool_calling: model.id === MODEL ? 'experimental_json' : 'unverified',
      ssh_billing: 'unverified',
    });
  }
  if (!unique.size) throw new BridgeError('Invalid Hugging Face model catalog');
  if (!unique.has(MODEL)) unique.set(MODEL, { ...fallback, ssh_available: true, ssh_access: 'linked_hf_account', ssh_tool_calling: 'experimental_json', ssh_billing: 'unverified' });
  return [...unique.values()];
}

export class ModelCatalog {
  constructor({ stateDir, fetcher = fetch, ttlMs = 15 * 60 * 1000, catalogRetryMs = 30000 } = {}) {
    this.stateDir = stateDir;
    this.fetcher = fetcher;
    this.ttlMs = ttlMs;
    this.cached = undefined;
    this.pending = undefined;
    this.catalogRetryMs = catalogRetryMs;
    this.retryAt = 0;
  }

  async list({ refresh = false } = {}) {
    if (!refresh && this.cached && (Date.now() < this.retryAt || (!this.cached.stale && Date.now() - this.cached.at < this.ttlMs))) return this.cached;
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async load() {
    try {
      const response = await this.fetcher(CATALOG_URL, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const result = { at: Date.now(), source: CATALOG_URL, stale: false, data: normalizeCatalog(body.data) };
      this.cached = result;
      this.retryAt = 0;
      if (this.stateDir) {
        // Cache failure does not turn a valid upstream catalog into a failed discovery.
        try {
          await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
          await writeFile(join(this.stateDir, 'models.json'), JSON.stringify(result), { mode: 0o600 });
        } catch { /* An in-memory catalog still works in a read-only installation. */ }
      }
      return result;
    } catch (error) {
      let previous = this.cached;
      if (!previous && this.stateDir) {
        try {
          const disk = JSON.parse(await readFile(join(this.stateDir, 'models.json'), 'utf8'));
          previous = { ...disk, data: normalizeCatalog(disk.data) };
        } catch { /* First run may not have a cache. */ }
      }
      this.cached = { ...(previous ?? { at: 0, source: 'verified-default', data: normalizeCatalog([fallback]) }), stale: true, error: `Catalog refresh failed: ${error.message}` };
      this.retryAt = Date.now() + this.catalogRetryMs;
      return this.cached;
    }
  }
}

export function magpieModel(model) {
  return {
    name: `${model.id}${model.ssh_available ? ' (SSH · experimental tools)' : ' (SSH model switching unsupported)'}`,
    // The SSH textarea, rather than the model's API context, is the bottleneck.
    // Encourage early Agent compaction; the exact character guard is in protocol.
    limit: { context: 2000, output: 1000 },
    tool_call: model.ssh_available,
    modalities: { input: ['text'], output: ['text'] },
    disabled: !model.ssh_available,
  };
}
