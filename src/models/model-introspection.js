/**
 * Public model introspection (Build 4).
 *
 * GET /v1/models        -> { object: 'list', data: [...] } (OpenAI-compatible)
 * GET /v1/models/:id    -> single shape-compatible model object or 404
 *
 * Lists public usable names only: direct public models, aliases and routing
 * groups. NEVER exposes provider keys, environment variable names, private
 * base URLs, internal health (cooldown/disable) state or provider ids unless
 * the provider id is deliberately part of a public model name.
 *
 * Both sources are supported: the immutable model registry (JSON file config
 * with aliases/groups) and the legacy environment-only provider list.
 */

/** OpenAI-compatible model object shape with a stable, non-leaking surface. */
function publicModel(id, kind = 'model') {
  return {
    id,
    object: 'model',
    created: 0,
    owned_by: 'organization_owner',
    ...(kind !== 'model' ? { metadata: { kind } } : {})
  };
}

/**
 * @param {object} routingRegistry - ModelRoutingRegistry (may be null in pure-env mode)
 * @param {object} envRegistry - legacy ProviderRegistry (env-only mode)
 */
export function createModelIntrospection(routingRegistry, envRegistry) {
  const legacy = routingRegistry === null || routingRegistry === undefined;

  function listModels() {
    if (legacy) return envRegistry.getAllModels();
    return { object: 'list', data: routingRegistry.listPublicModels() };
  }

  function lookupModel(id) {
    if (legacy) return envRegistry.getModel(id);
    return routingRegistry.lookupPublicModel(id);
  }

  return { listModels, lookupModel, isLegacy: legacy };
}

export { publicModel };
export default createModelIntrospection;