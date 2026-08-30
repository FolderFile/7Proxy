/**
 * Strict file-configuration validation (Build 4).
 *
 * Validates the parsed JSON of 7proxy.json BEFORE any key material is
 * resolved. Every error message names the configuration path and the offending
 * identifier, never a secret value.
 *
 * Structural guarantees produced here (all treated as immutable downstream):
 *   - provider ids, model names, alias/group names use safe characters
 *   - targets reference known providers; group/model targets reference models
 *     the target provider actually offers
 *   - aliases resolve to a model or group (chains allowed, cycles rejected)
 *   - groups have >= 1 target, unique targets, a valid strategy and finite
 *     positive weights where present
 *   - capability values match the internal vocabulary
 *   - server timing fields (timeouts, retries, cooldown) are valid
 *   - public names are globally unambiguous
 */

import { isValidStrategy } from '../models/strategies.js';

/** Prototype-pollution keys must never appear in configuration objects. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Identifiers (provider ids, model names, alias/group names) are constrained
 * to avoid URL/path confusion and header injection: letters, digits and
 * `_ - . : / @ + ~` (dot-segments like ".." are rejected). This deliberately
 * admits the datacenter model vocabulary (glm-5.2, kimi-k2.7-code,
 * qwen3.8-27b-abliterated-nvfp4, hy3-heretic-bf16, deepseek_v4_pro, ...).
 */
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@~+\-/]{0,199}$/;

const PROVIDER_TYPES = new Set(['openai-compatible', 'anthropic-compatible']);
const API_MODES = new Set(['native', 'translated', 'unsupported']);

function err(configPath, msg) {
  const e = new Error(`${configPath}: ${msg}`);
  e.configError = true;
  return e;
}

function rejectForbiddenKeys(node, path, configPath) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => rejectForbiddenKeys(v, `${path}[${i}]`, configPath));
    return;
  }
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw err(configPath, `forbidden key '${key}' at ${path || 'config root'}`);
    }
    rejectForbiddenKeys(node[key], path ? `${path}.${key}` : key, configPath);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkIdent(name, what, configPath) {
  if (typeof name !== 'string' || !IDENT_RE.test(name) || name === '.' || name === '..') {
    throw err(configPath, `invalid ${what} identifier '${String(name)}'`);
  }
}

export function validateFileConfig(raw, configPath) {
  rejectForbiddenKeys(raw, '', configPath);
  const out = { providers: {}, models: {}, aliases: {}, groups: {} };

  // ---- providers -----------------------------------------------------------
  if (!isPlainObject(raw.providers) || Object.keys(raw.providers).length === 0) {
    throw err(configPath, '"providers" must be an object with at least one provider');
  }
  for (const [id, spec] of Object.entries(raw.providers)) {
    checkIdent(id, 'provider', configPath);
    const p = spec ?? {};
    if (p.type !== 'openai-compatible' && p.type !== 'anthropic-compatible') {
      throw err(configPath, `provider '${id}': unknown provider type '${String(p.type)}' (expected 'openai-compatible' or 'anthropic-compatible')`);
    }
    if (!isPlainObject(p.baseUrl) && (typeof p.baseUrl !== 'string' || p.baseUrl === '')) {
      throw err(configPath, `provider '${id}' has an invalid baseUrl`);
    }
    let u;
    try {
      u = new URL(p.baseUrl);
    } catch {
      throw err(configPath, `provider '${id}' has an invalid baseUrl: ${p.baseUrl}`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw err(configPath, `provider '${id}': baseUrl must use http(s)`);
    }
    if (u.protocol !== 'https:' && !isLocalhostBase(u)
        && process.env.ALLOW_INSECURE_UPSTREAM !== 'true') {
      throw err(configPath, `provider '${id}': non-HTTPS baseUrl '${u.protocol}//${u.host}' requires ALLOW_INSECURE_UPSTREAM=true (localhost/private development only)`);
    }
    if (!Array.isArray(p.keys) || p.keys.length === 0) {
      throw err(configPath, `provider '${id}' has no key entries`);
    }
    for (const k of p.keys) {
      if (!isPlainObject(k) || typeof k.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k.env)) {
        throw err(configPath, `provider '${id}': every key entry must be { "env": "ENV_VAR_NAME" }`);
      }
    }
    if (!Array.isArray(p.models) || p.models.length === 0) {
      throw err(configPath, `provider '${id}' has no models`);
    }
    for (const m of p.models) {
      checkIdent(m, 'model', configPath);
    }
    if (new Set(p.models).size !== p.models.length) {
      throw err(configPath, `provider '${id}' lists duplicate models`);
    }

    // Capabilities: strict subset check.
    const caps = {};
    if (p.capabilities !== undefined) {
      if (!isPlainObject(p.capabilities)) throw err(configPath, `provider '${id}': capabilities must be an object`);
      for (const [ck, cv] of Object.entries(p.capabilities)) {
        switch (ck) {
          case 'chatCompletions':
          case 'tools':
          case 'vision':
          case 'reasoning':
          case 'metadata':
          case 'serviceTier':
          case 'previousResponseId':
          case 'store':
          case 'truncation':
          case 'textFormat':
          case 'thinking':
          case 'documents':
          case 'betas':
            if (typeof cv !== 'boolean') throw err(configPath, `provider '${id}': capability '${ck}' must be a boolean`);
            caps[ck] = cv;
            break;
          case 'responses':
          case 'anthropicMessages':
          case 'anthropicTokenCount':
            if (!API_MODES.has(cv)) {
              throw err(configPath, `provider '${id}': capability '${ck}' must be one of native|translated|unsupported`);
            }
            caps[ck] = cv;
            break;
          case 'anthropicVersion':
            if (typeof cv !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(cv)) {
              throw err(configPath, `provider '${id}': capability 'anthropicVersion' must be a date string (YYYY-MM-DD)`);
            }
            caps[ck] = cv;
            break;
          case 'messagesPath':
          case 'countTokensPath':
            if (typeof cv !== 'string' || !cv.startsWith('/')) {
              throw err(configPath, `provider '${id}': capability '${ck}' must start with '/'`);
            }
            caps[ck] = cv;
            break;
          default:
            throw err(configPath, `provider '${id}': unknown capability '${ck}'`);
        }
      }
    }
    out.providers[id] = { type: p.type, baseUrl: p.baseUrl, keys: p.keys, models: p.models, capabilities: caps };
  }

  // ---- models (direct public models with explicit targets) -----------------
  if (raw.models !== undefined) {
    if (!isPlainObject(raw.models)) throw err(configPath, '"models" must be an object');
    for (const [name, spec] of Object.entries(raw.models)) {
      checkIdent(name, 'model', configPath);
      const s = spec ?? {};
      if (!Array.isArray(s.targets) || s.targets.length === 0) {
        throw err(configPath, `model '${name}' has no targets`);
      }
      const seen = new Set();
      for (const t of s.targets) {
        if (!isPlainObject(t) || typeof t.provider !== 'string') {
          throw err(configPath, `model '${name}': each target must be { provider, upstreamModel }`);
        }
        const targetKey = `${t.provider}|${t.upstreamModel}`;
        if (seen.has(targetKey)) throw err(configPath, `model '${name}' has duplicate target entries (${targetKey})`);
        seen.add(targetKey);
        if (!out.providers[t.provider]) {
          throw err(configPath, `model '${name}' targets unknown provider '${t.provider}'`);
        }
        // The upstream model must be offered by the target provider.
        if (!out.providers[t.provider].models.includes(t.upstreamModel)) {
          throw err(configPath, `model '${name}': provider '${t.provider}' does not offer upstream model '${t.upstreamModel}'`);
        }
      }
      out.models[name] = { targets: s.targets };
    }
  }

  // Provider-declared models are directly usable public names; explicit model
  // entries may name a provider model (to pin/alias an upstream id) or any
  // other valid identifier (a pure override label). Both are legal.

  // ---- groups ---------------------------------------------------------------
  if (raw.groups !== undefined) {
    if (!isPlainObject(raw.groups)) throw err(configPath, '"groups" must be an object');
    for (const [name, spec] of Object.entries(raw.groups)) {
      checkIdent(name, 'group', configPath);
      const g = spec ?? {};
      if (!Array.isArray(g.targets) || g.targets.length === 0) {
        throw err(configPath, `group '${name}' is empty (needs at least one target)`);
      }
      if (g.strategy !== undefined && !isValidStrategy(g.strategy)) {
        throw err(configPath, `group '${name}': invalid strategy '${String(g.strategy)}' (expected fallback|round-robin|random|weighted-random)`);
      }
      const seen = new Set();
      for (const t of g.targets) {
        if (!isPlainObject(t) || typeof t.provider !== 'string' || typeof t.model !== 'string') {
          throw err(configPath, `group '${name}': each target must be { provider, model }`);
        }
        if (t.weight !== undefined) {
          if (typeof t.weight !== 'number' || !Number.isFinite(t.weight) || t.weight <= 0) {
            throw err(configPath, `group '${name}': target weight must be a positive finite number`);
          }
        }
        const targetKey = `${t.provider}|${t.model}`;
        if (seen.has(targetKey)) throw err(configPath, `group '${name}' has duplicate target entries (${targetKey})`);
        seen.add(targetKey);
        if (!out.providers[t.provider]) {
          throw err(configPath, `group '${name}' targets unknown provider '${t.provider}'`);
        }
        if (!out.providers[t.provider].models.includes(t.model)) {
          throw err(configPath, `group '${name}': provider '${t.provider}' does not offer model '${t.model}'`);
        }
      }
      out.groups[name] = { strategy: g.strategy ?? 'fallback', targets: g.targets };
    }
  }

  // ---- aliases --------------------------------------------------------------
  if (raw.aliases !== undefined) {
    if (!isPlainObject(raw.aliases)) throw err(configPath, '"aliases" must be an object');
    for (const [name, target] of Object.entries(raw.aliases)) {
      checkIdent(name, 'alias', configPath);
      if (typeof target !== 'string') throw err(configPath, `alias '${name}' must map to a model, alias or group name`);
      out.aliases[name] = target;
    }
  }

  // Alias targets: resolve chains, reject dangling pointers and cycles.
  // Provider-declared models are direct public names, so they are legal
  // alias targets too (e.g. "claude" -> "claude-sonnet-4").
  const providerModelNames = new Set();
  for (const p of Object.values(out.providers)) for (const m of p.models) providerModelNames.add(m);
  const kindOf = (n) => out.models[n] ? 'model'
    : providerModelNames.has(n) ? 'model'
    : out.groups[n] ? 'group'
    : typeof out.aliases[n] === 'string' ? 'alias' : null;
  for (const [name, target] of Object.entries(out.aliases)) {
    if (kindOf(target) === null) {
      throw err(configPath, `alias '${name}' points at unknown model, alias or group '${target}'`);
    }
  }
  for (const name of Object.keys(out.aliases)) {
    // Walk the chain to detect cycles (multi-level alias chains are legal).
    const visited = new Set([name]);
    let cur = out.aliases[name];
    while (true) {
      const kind = kindOf(cur);
      if (kind === 'alias') {
        if (visited.has(cur)) {
          const cycle = [...visited, cur].join(' -> ');
          throw err(configPath, `alias cycle detected: ${cycle}`);
        }
        visited.add(cur);
        cur = out.aliases[cur];
        continue;
      }
      break;
    }
  }

  // Groups must reference providers/models that exist (already validated):
  // groups nest only via aliases; a group target may not point at a group.
  for (const [name, g] of Object.entries(out.groups)) {
    for (const t of g.targets) {
      if (out.groups[t.model]) {
        throw err(configPath, `group '${name}' targets group '${t.model}'; groups may only target provider models`);
      }
    }
  }

  // ---- public-name ambiguity (models vs aliases vs groups) ------------------
  const publicSeen = new Map();
  const claim = (name, what) => {
    if (publicSeen.has(name)) {
      throw err(configPath, `ambiguous public model name '${name}' (declared as both ${publicSeen.get(name)} and ${what})`);
    }
    publicSeen.set(name, what);
  };
  // Direct public models: union of provider models plus explicitly targeted models.
  const directPublic = new Set();
  for (const p of Object.values(out.providers)) for (const m of p.models) directPublic.add(m);
  for (const name of Object.keys(out.models)) directPublic.add(name);
  for (const name of directPublic) claim(name, 'model');
  for (const name of Object.keys(out.groups)) claim(name, 'group');
  for (const name of Object.keys(out.aliases)) claim(name, 'alias');

  // ---- server timing settings ----------------------------------------------
  const server = raw.server ?? {};
  const checkPositive = (k, min, label) => {
    if (server[k] === undefined) return;
    if (typeof server[k] !== 'number' || !Number.isFinite(server[k]) || server[k] < min) {
      throw err(configPath, `server.${k} (${label}) must be a finite number >= ${min}`);
    }
  };
  checkPositive('requestTimeoutMs', 100, 'request timeout');
  checkPositive('streamTimeoutMs', 100, 'stream timeout');
  checkPositive('streamOverallTimeoutMs', 0, 'overall stream timeout');
  checkPositive('maxAttempts', 1, 'max attempts');
  checkPositive('maxAttemptsCeiling', 1, 'max attempts ceiling');
  checkPositive('retryBaseDelayMs', 0, 'retry delay');
  checkPositive('retryMaxDelayMs', 0, 'retry max delay');
  checkPositive('keyCooldownMs', 0, 'key cooldown');
  if (server.maxAttempts !== undefined && server.maxAttemptsCeiling !== undefined
      && server.maxAttempts > server.maxAttemptsCeiling) {
    throw err(configPath, 'server.maxAttempts must not exceed server.maxAttemptsCeiling');
  }

  return out;
}

/** Localhost / loopback detection for the HTTPS relaxation. */
function isLocalhostBase(u) {
  const h = u.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0';
}

export default { validateFileConfig };