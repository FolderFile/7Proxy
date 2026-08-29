/**
 * Provider registry and model routing with capability awareness.
 */

import { createProvider } from './base.js';
import { logger } from '../core/logger.js';

export class ProviderRegistry {
  constructor(providerConfigs, defaultProviderName) {
    this.providers = new Map();
    this.defaultProviderName = defaultProviderName;

    for (const config of providerConfigs) {
      const provider = createProvider(config);
      this.providers.set(provider.name, provider);
      logger.info('Provider registered', {
        provider: provider.name,
        models: provider.models.length,
        keys: provider.apiKeys.length
      });
    }
  }

  get(name) {
    return this.providers.get(name);
  }

  getDefault() {
    return this.get(this.defaultProviderName) || this.providers.values().next().value || null;
  }

  /**
   * Find the provider that owns a model.
   */
  getByModel(model) {
    if (!model) return null;
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(model)) return provider;
    }
    return null;
  }

  getAll() {
    return Array.from(this.providers.values());
  }

  /**
   * All models across providers as OpenAI model objects.
   * Also exposes a per-model lookup map.
   */
  getAllModels() {
    const models = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        models.push({
          id: model,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: provider.name
        });
      }
    }
    return models;
  }

  /**
   * Look up a single model object by id.
   */
  getModel(modelId) {
    for (const provider of this.providers.values()) {
      if (provider.supportsModel(modelId)) {
        return {
          id: modelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: provider.name
        };
      }
    }
    return null;
  }

  /**
   * Ordered failover list of providers for a requested model:
   * the owning provider first, then all others.
   */
  getFailoverProviders(model) {
    const all = this.getAll();
    const owner = this.getByModel(model);
    if (!owner) return all;
    return [owner, ...all.filter(p => p.name !== owner.name)];
  }

  /**
   * Ordered failover list restricted to providers that can serve `api`
   * ('chat' | 'responses') for the given body. The model-owning provider is
   * first (if capable), then every other capable provider in config order.
   *
   * Note: cross-provider failover intentionally re-serves the same model id on
   * other providers. This mirrors the existing Chat Completions behavior, where
   * every provider is attempted with the same body.
   */
  getCapableFailoverProviders(model, api, body = {}) {
    const all = this.getAll();
    const capable = all.filter(p => p.supportsApi(api, body));
    if (capable.length === 0) return [];
    const owner = this.getByModel(model);
    if (!owner || !capable.includes(owner)) {
      // Prefer the model owner order anyway if it is capable; else keep order.
      return capable;
    }
    return [owner, ...capable.filter(p => p.name !== owner.name)];
  }
}

export default ProviderRegistry;