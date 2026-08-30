/**
 * Immutable model registry (Build 4).
 *
 * Built once at startup from validated configuration or from the legacy
 * environment-only provider list; the config objects are deep-frozen so
 * request handlers can never mutate the routing state.
 *
 * A resolution answers:
 *   - the requested public name
 *   - what kind of public name it was (model | alias | group)
 *   - the ordered eligible targets [{provider, model, weight}]
 *   - the routing strategy
 *   - per-target resolved capabilities and provider reference
 *
 * Public names must be unambiguous: a name that is both a direct model and an
 * alias/group is a configuration error (defensive double check here).
 *
 * Aliases may chain to other aliases (bounded), but never cycle; groups never
 * reference groups (flat membership keeps cycle detection total).
 */

import { buildTargetPlan, isValidStrategy } from './strategies.js';

/** Prototype-pollution keys are rejected anywhere in the config tree. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Deep freeze with forbidden-key rejection. Throws on unsafe keys. */
export function deepFreeze(node, path = '') {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) deepFreeze(node[i], `${path}[${i}]`);
    Object.freeze(node);
    return node;
  }
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Forbidden key '${key}' at ${path || 'config root'}`);
    }
    deepFreeze(node[key], path ? `${path}.${key}` : key);
  }
  Object.freeze(node);
  return node;
}

export class ModelRegistry {
  /**
   * @param {object} opts
   * @param {Array} opts.providers - provider objects with {name, models, capabilities, supportsApi}
   * @param {object} [opts.aliases] - alias -> target name (model, group or alias)
   * @param {object} [opts.groups] - name -> { strategy, targets: [{provider, model}] }
   * @param {Function} [opts.capabilityFilter] - (targets, api, body) => filtered targets
   */
  constructor({ providers, models = {}, aliases = {}, groups = {}, capabilityFilter = defaultCapabilityFilter }) {
    this.providers = providers;             // Map name -> provider (already frozen where possible)
    this.capabilityFilter = capabilityFilter;
    this._rrCursor = 0;                      // round-robin state (registry-owned, not config)

    // Explicit model entries from the file config: public name -> targets
    // [{provider, model: upstreamId}]. They refine/override same-named
    // provider-declared models (the documented pinning pattern).
    /** @type {Map<string, Array<{provider: string, model: string, weight?: number}>>} */
    this._explicit = new Map();
    for (const [name, spec] of Object.entries(models)) {
      this._explicit.set(name, Object.freeze((spec.targets || []).map(t =>
        Object.freeze({ provider: t.provider, model: t.upstreamModel, weight: t.weight }))));
    }

    // Index direct provider models: public name -> [{provider, model}] order-stable.
    /** @type {Map<string, Array<{provider: string, model: string, weight?: number}>>} */
    this._direct = new Map();
    for (const provider of providers.values()) {
      for (const model of provider.models) {
        if (!this._direct.has(model)) this._direct.set(model, []);
        const list = this._direct.get(model);
        if (!list.some(t => t.provider === provider.name)) {
          list.push({ provider: provider.name, model });
        }
      }
    }

    /** @type {Map<string, {strategy: string, targets: Array}>} */
    this._groups = new Map();
    for (const [name, group] of Object.entries(groups)) {
      this._groups.set(name, Object.freeze({
        strategy: strategyOf(group),
        targets: Object.freeze((group?.targets || []).map(t =>
          Object.freeze({ provider: t.provider, model: t.model, weight: t.weight })))
      }));
    }

    /** Aliases resolved to their final target kind+name (chains followed). */
    /** @type {Map<string, {kind: string, name: string, chain: string[]}>} */
    this._aliases = new Map();
    this._buildAliasIndex(aliases);

    // Public names: direct models (derived and explicit), groups, aliases.
    // An explicit entry over a provider-declared model is a refinement (the
    // documented pinning pattern), not an ambiguity; group/alias collisions
    // with any existing name remain errors.
    this._publicNames = new Set();
    for (const name of this._direct.keys()) this._addRawName(name);
    for (const name of this._explicit.keys()) {
      if (!this._publicNames.has(name)) this._publicNames.add(name);
    }
    for (const name of this._groups.keys()) this._addPublicName(name, 'group');
    for (const name of this._aliases.keys()) this._addPublicName(name, 'alias');
  }

  _addPublicName(name, kind) {
    if (this._publicNames.has(name)) {
      throw new Error(`Ambiguous public model name '${name}' (${kind}); public names must be unique across models, aliases and groups`);
    }
    this._addRawName(name);
  }

  /** Ambiguity check excluding private upstream duplicates. */
  _addRawName(name) {
    if (this._publicNames.has(name)) {
      throw new Error(`Ambiguous public model name '${name}': defined more than once as a public name`);
    }
    this._publicNames.add(name);
  }

  /** Follow alias chains with visited-set cycle safety (validator already rejected cycles). */
  _buildAliasIndex(aliases) {
    for (const name of Object.keys(aliases)) {
      this._resolveAlias(name, aliases, new Set(), []);
    }
  }

  _resolveAlias(name, aliases, visited, chain) {
    if (this._aliases.has(name)) return this._aliases.get(name);
    if (visited.has(name)) {
      throw new Error(`Alias cycle detected: ${[...chain, name].join(' -> ')}`);
    }
    visited.add(name);
    const target = aliases[name];
    if (target === undefined) return null;
    if (this._groups.has(target)) {
      const entry = { kind: 'group', name: target, chain: [...chain, name] };
      this._aliases.set(name, Object.freeze(entry));
      return entry;
    }
    if (this._direct.has(target) || this._explicit.has(target)) {
      const entry = { kind: 'model', name: target, chain: [...chain, name] };
      this._aliases.set(name, Object.freeze(entry));
      return entry;
    }
    if (typeof aliases[target] === 'string') {
      const inner = this._resolveAlias(target, aliases, visited, [...chain, name]);
      if (inner) {
        const entry = { kind: inner.kind, name: inner.name, chain: [...chain, name, ...inner.chain] };
        this._aliases.set(name, Object.freeze(entry));
        return entry;
      }
    }
    return null;
  }

  /** Targets for a public model name: explicit entry first, derived fallback. */
  _modelTargets(name) {
    if (this._explicit.has(name)) return this._explicit.get(name).map(t => this._resolveTarget(t));
    return (this._direct.get(name) || []).map(t => this._resolveTarget(t));
  }

  /** Resolve a public name to a full resolution object (or null). */
  resolve(name) {
    if (typeof name !== 'string' || !name) return null;

    if (this._aliases.has(name)) {
      const a = this._aliases.get(name);
      if (a.kind === 'group') return this._resolveGroup(a.name, a.chain, name);
      return {
        kind: 'alias',
        requested: name,
        resolvedName: a.name,
        strategy: 'fallback',
        targets: this._modelTargets(a.name)
      };
    }
    if (this._groups.has(name)) return this._resolveGroup(name, [name], name);
    if (this._explicit.has(name) || this._direct.has(name)) {
      return {
        kind: 'model',
        requested: name,
        resolvedName: name,
        strategy: 'fallback',
        targets: this._modelTargets(name)
      };
    }
    return null;
  }

  _resolveGroup(name, chain, requested) {
    const g = this._groups.get(name);
    if (!g) return null;
    return {
      kind: 'group',
      requested,
      resolvedName: name,
      strategy: g.strategy,
      targets: g.targets.map(t => this._resolveTarget(t))
    };
  }

  _resolveTarget(t) {
    return {
      provider: t.provider,
      model: t.model,
      weight: t.weight,
      providerRef: this.providers.get(t.provider) || null
    };
  }

  /** Truthy when the public name exists (model, group or alias). */
  has(name) {
    return this.resolve(name) !== null;
  }

  /** Resolve + capability filter + ordered target plan (finite length). */
  resolvePlan(name, api, body, seed) {
    const resolution = this.resolve(name);
    if (!resolution) return null;
    let targets = this.capabilityFilter(resolution.targets, api, body);
    if (!targets || targets.length === 0) {
      return { ...resolution, targets: [], plan: [] };
    }
    const plan = buildTargetPlan(
      { kind: resolution.kind, strategy: resolution.strategy, targets },
      seed
    );
    return { ...resolution, targets, plan };
  }

  /** Public model list for GET /v1/models (no provider/baseUrl/key details). */
  listPublicModels() {
    const ids = [...this._publicNames];
    return ids.map(id => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'organization_owner'
    }));
  }

  /** Public lookup for GET /v1/models/:id. Returns null when unknown. */
  lookupPublicModel(id) {
    if (typeof id !== 'string' || !this._publicNames.has(id)) return null;
    return { id, object: 'model', created: 0, owned_by: 'organization_owner' };
  }

  /** All public names (direct models, aliases, groups). */
  publicNames() {
    return [...this._publicNames];
  }
}

function strategyOf(group) {
  const s = group?.strategy;
  return isValidStrategy(s) ? s : 'fallback';
}

/**
 * Default capability filter: drop targets whose provider cannot serve `api`
 * (and requested fields) for this body. Mirrors the existing semantics of
 * providers' supportsApi so existing tests keep their routing behavior.
 */
function defaultCapabilityFilter(targets, api, body) {
  return targets.filter(t => t.providerRef && t.providerRef.supportsApi(api, body));
}

export default ModelRegistry;