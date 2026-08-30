/**
 * Public-name routing (Build 4).
 *
 * Bridges the immutable ModelRegistry and provider adapters:
 *   - builds the registry once from either a validated JSON file config
 *     (with explicit models / aliases / routing groups) or the legacy
 *     environment-only provider list (full backward compatibility)
 *   - resolves a public name to an ordered, capability-filtered,
 *     strategy-planned target list BEFORE any upstream attempt
 *   - every plan is finite: its length is at most the number of declared
 *     targets; the transport loop's global attempt budget (config.maxAttempts)
 *     remains the sole authority on how many attempts actually run
 *
 * Legacy env mode reproduces the previous semantics exactly:
 *   - every provider's declared models are public direct models
 *   - the model-owning provider is attempted first, then other capable
 *     providers in configuration order (implicit cross-provider failover)
 *   - ENFORCE_EXPLICIT_GROUPS=true disables the owner-first reorder
 *
 * Config-file mode uses the declared groups strictly: a model/group/alias
 * resolves ONLY to its declared targets (no implicit failover).
 *
 * Capability awareness is two-layered (both zero-upstream-attempt):
 *   1. coarse pass here: API mode support and body-implied needs
 *      (tools / vision / reasoning) drop targets before planning
 *   2. field-level gaps (per provider translation knowledge) throw
 *      UnsupportedFieldError in prepareBody during the plan walk - the
 *      upstream is never called for a skipped provider
 */

import { ModelRegistry } from './registry.js';
import { buildTargetPlan, resetRoundRobinCounter } from './strategies.js';

/** Capability needs implied by a request body for an API surface. */
function requiredFeatures(api, body) {
  const needs = { tools: false, vision: false, reasoning: false };
  if (!body || typeof body !== 'object') return needs;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (api === 'chat' || api === 'responses') {
    needs.tools = hasTools;
    if (api === 'responses') {
      needs.reasoning = body.reasoning !== undefined && body.reasoning !== null;
    }
    // Vision: image parts in chat content or Responses input.
    if (Array.isArray(body.messages)) {
      outer: for (const msg of body.messages) {
        const c = msg?.content;
        if (!Array.isArray(c)) continue;
        for (const part of c) {
          if (part?.type === 'image_url' || part?.type === 'input_image') {
            needs.vision = true;
            break outer;
          }
        }
      }
    }
  }
  if (api === 'anthropic-messages') {
    needs.tools = hasTools;
    if (Array.isArray(body.messages)) {
      outerMsgs: for (const msg of body.messages) {
        const c = msg?.content;
        if (!Array.isArray(c)) continue;
        for (const block of c) {
          if (block?.type === 'image') {
            needs.vision = true;
            break outerMsgs;
          }
        }
      }
    }
  }
  return needs;
}

/**
 * Coarse capability filter: drop targets whose provider cannot serve `api`
 * (mode level, including field constraints already known to supportsApi) or
 * that cannot serve body-implied tool/vision/reasoning needs.
 * Deliberately does NOT pre-filter anthropic thinking/document blocks on
 * translated providers: prepareBody rejects those with a precise
 * UnsupportedFieldError (which also consumes zero upstream attempts and names
 * the field in the final error).
 */
function capabilityFilter(targets, api, body) {
  const needs = requiredFeatures(api, body);
  return targets.filter(t => {
    const p = t.providerRef;
    if (!p) return false;
    if (!p.supportsApi(api, body)) return false;
    const caps = p.capabilities;
    if (needs.tools && caps.tools === false) return false;
    if (needs.vision && caps.vision === false) return false;
    if (needs.reasoning && !caps.reasoning) return false;
    return true;
  });
}

export class ModelRoutingRegistry {
  /**
   * @param {object} opts
   * @param {Map<string, object>} opts.providers - name -> provider object
   * @param {object|null} opts.fileConfig - parsed JSON config (providers/models/aliases/groups) or null
   * @param {object} opts.rawConfig - full server config
   */
  constructor({ providers, fileConfig, rawConfig }) {
    this.fileMode = fileConfig !== null && fileConfig !== undefined;
    this.defaultProviderName = rawConfig.defaultProvider;
    this.enforceExplicit = process.env.ENFORCE_EXPLICIT_GROUPS === 'true';

    const providerMap = new Map();
    for (const [name, p] of providers) providerMap.set(name, p);
    this.providers = providerMap;

    this.registry = new ModelRegistry({
      providers: providerMap,
      models: this.fileMode ? (fileConfig.models || {}) : {},
      aliases: this.fileMode ? (fileConfig.aliases || {}) : {},
      groups: this.fileMode ? (fileConfig.groups || {}) : {},
      capabilityFilter
    });
  }

  /**
   * Resolve a public name for an API call into an ordered upstream target
   * plan. Returns null when the name is unknown.
   *   { requested, kind, resolvedName, strategy, eligibleCount,
   *     plan: [{provider, providerId, upstreamModel}] }
   * An empty plan means "known name, but no provider can serve this request".
   */
  resolve(name, api, body, seed) {
    const resolution = this.registry.resolve(name);
    if (!resolution) return null;

    const allTargets = resolution.targets;
    const targets = capabilityFilter(allTargets, api, body || {});

    let orderedTargets;
    if (this.fileMode) {
      const strategy = resolution.strategy || 'fallback';
      orderedTargets = targets.length > 0
        ? buildTargetPlan({ strategy, targets }, seed)
        : [];
      return {
        requested: name,
        kind: resolution.kind,
        resolvedName: resolution.resolvedName,
        strategy,
        eligibleCount: targets.length,
        plan: orderedTargets.map(t => ({
          provider: t.providerRef,
          providerId: t.provider,
          upstreamModel: t.model
        }))
      };
    }

    // Legacy env mode.
    let owner = null;
    if (!this.enforceExplicit) {
      owner = targets.find(t => t.providerRef.models.includes(name)) || null;
    }
    orderedTargets = owner ? [owner, ...targets.filter(t => t !== owner)] : targets;
    return {
      requested: name,
      kind: resolution.kind,
      resolvedName: resolution.resolvedName,
      strategy: 'fallback',
      eligibleCount: targets.length,
      plan: orderedTargets.map(t => ({
        provider: t.providerRef,
        providerId: t.provider,
        upstreamModel: t.model
      }))
    };
  }

  /** Resolve without capability filtering (existence/shape introspection). */
  resolveAny(name) {
    const r = this.registry.resolve(name);
    if (!r) return null;
    return {
      requested: name,
      kind: r.kind,
      resolvedName: r.resolvedName,
      strategy: r.strategy,
      targets: r.targets
    };
  }

  /** True when the public name exists (model, alias or group). */
  has(name) {
    return this.registry.has(name);
  }

  /** GET /v1/models payload: public names only, no private details. */
  listPublicModels() {
    return this.registry.listPublicModels();
  }

  /** GET /v1/models/:id payload (public shape), null when unknown. */
  lookupPublicModel(id) {
    return this.registry.lookupPublicModel(id);
  }

  /** All public names. */
  publicNames() {
    return this.registry.publicNames();
  }

  /** Reset the round-robin cursor (tests). */
  static resetRotation() {
    resetRoundRobinCounter();
  }
}

export { capabilityFilter, requiredFeatures };
export default ModelRoutingRegistry;