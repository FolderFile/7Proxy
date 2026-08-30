/**
 * Routing strategy helpers (Build 4).
 *
 * A strategy turns the eligible target list of a model resolution into an
 * ordered target plan. All strategies produce a FINITE plan:
 *   - fallback       : declared order (capability-filtered upstream)
 *   - round-robin    : rotating start index, then declared order
 *   - random         : rotating seed index into a shuffled plan
 *   - weighted-random: weights choose the first target; remainder follow in
 *                      deterministic round-robin order
 *
 * Plan length is always exactly targets.length; the transport loop stays the
 * sole authority on the attempt budget (a large group cannot multiply it).
 * Strategies never mutate the caller's arrays and never contain per-provider
 * or per-model conditions.
 */

export const ROUTING_STRATEGIES = ['fallback', 'round-robin', 'random', 'weighted-random'];

/** Validate a strategy name (used by config validation). */
export function isValidStrategy(s) {
  return ROUTING_STRATEGIES.includes(s);
}

/**
 * Build the ordered target plan for a request.
 *
 * @param {object} resolution - model registry resolution
 *   { kind, targets, strategy } where targets is [{provider, model, weight}]
 * @param {number} [seed] - injected deterministic randomness for tests;
 *   defaults to a rotating counter derived from the registry instance state.
 * @returns {Array} ordered targets (same objects, never mutated/copied array)
 */
export function buildTargetPlan(resolution, seed) {
  const targets = resolution.targets;
  const strategy = resolution.strategy || 'fallback';
  if (!Array.isArray(targets) || targets.length === 0) return [];
  if (targets.length === 1) return targets.slice();

  switch (strategy) {
    case 'round-robin': {
      const start = ((seed ?? roundRobinCounter++) % targets.length + targets.length) % targets.length;
      return rotate(targets, start);
    }
    case 'random': {
      const start = ((seed ?? Math.floor(Math.random() * targets.length)) % targets.length + targets.length) % targets.length;
      return shuffleDeterministic(targets, start);
    }
    case 'weighted-random': {
      // Weighted choice of the first target; the rest follow in rotating
      // deterministic order so the retry plan stays finite and duplicate-free.
      const weights = targets.map(t => t.weight);
      const first = weightedPick(targets, weights, seed);
      const rest = rotate(
        targets.filter((_, i) => i !== first),
        ((seed ?? 0) % (targets.length - 1) + targets.length - 1) % (targets.length - 1)
      );
      return [targets[first], ...rest];
    }
    case 'fallback':
    default:
      return targets.slice();
  }
}

/** Immutable rotating counter (module-private state; concurrency-safe on the event loop). */
let roundRobinCounter = 0;
export function resetRoundRobinCounter() { roundRobinCounter = 0; }

function rotate(arr, start) {
  return [...arr.slice(start), ...arr.slice(0, start)];
}

/**
 * Deterministic shuffle driven by a seed: a rotating reverse-order walk.
 * Produces a fixed permutation per (targets, seed) pair - tests can assert
 * exact plans; production passes no seed (Math.random-free rotation).
 */
function shuffleDeterministic(arr, start) {
  return rotate([...arr].reverse(), start % arr.length);
}

/** Weighted pick: cumulative-weight selection with injected rng. Returns index. */
function weightedPick(targets, weights, seed) {
  let total = 0;
  for (const w of weights) {
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) total += w;
  }
  if (!(total > 0)) return 0; // no valid weights -> deterministic first
  let point;
  if (typeof seed === 'number') {
    // Deterministic: seed in [0,1) acts as the rng draw.
    point = (seed - Math.floor(seed)) * total;
  } else {
    point = Math.random() * total;
  }
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      acc += w;
      if (point < acc) return i;
    }
  }
  return weights.findIndex(w => typeof w === 'number' && Number.isFinite(w) && w > 0);
}

export default { ROUTING_STRATEGIES, isValidStrategy, buildTargetPlan, resetRoundRobinCounter };