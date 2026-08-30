/**
 * Routing bootstrap (Build 4).
 *
 * Wires configuration into the immutable routing primitives at startup:
 *   - file mode: providers are instantiated through the type adapter registry
 *     (createProviderFromSpec) and a ModelRoutingRegistry is built from the
 *     validated file config (models / aliases / groups / strategies)
 *   - env-only mode: providers come from the legacy ProviderRegistry and the
 *     routing registry reproduces the legacy owner-first failover semantics
 *
 * Called once from app.js; request handlers only read frozen state.
 */

import { createProviderFromSpec } from '../providers/registry.js';
import { ModelRoutingRegistry } from './routing.js';

/**
 * Instantiate provider objects from file-config specs via adapters.
 * Returns a Map<name, provider> compatible with both the router's key
 * manager wiring and the legacy ProviderRegistry interface used by edges.
 */
export function buildFileModeProviders(config) {
  const map = new Map();
  for (const spec of config.providers) {
    const provider = createProviderFromSpec({
      name: spec.name,
      providerType: spec.providerType,
      baseUrl: spec.baseUrl,
      apiKeys: spec.apiKeys,
      models: spec.models,
      capabilities: spec.capabilities
    });
    map.set(provider.name, provider);
  }
  if (map.size === 0) {
    throw new Error('no providers could be instantiated from configuration');
  }
  return map;
}

/**
 * Build the immutable routing registry for either mode.
 * Returns null only when impossible (never in practice: providers exist).
 */
export function buildRoutingRegistry(config, providers) {
  const providerMap = providers instanceof Map
    ? providers
    : new Map(providers.getAll().map(p => [p.name, p]));
  return new ModelRoutingRegistry({
    providers: providerMap,
    fileConfig: config.fileConfig ?? null,
    rawConfig: config
  });
}

export default { buildFileModeProviders, buildRoutingRegistry };