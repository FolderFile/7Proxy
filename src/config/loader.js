/**
 * JSON configuration loader (Build 4).
 *
 * Loads config/7proxy.json (override: SEVEN_PROXY_CONFIG) and translates it
 * into the same shape the existing environment-only loader produces, keeping
 * the two paths convergent on one validated shape.
 *
 * Security rules enforced here (validator.js re-checks semantic rules):
 *   - keys are ALWAYS resolved from environment variables ({ "env": "NAME" });
 *     inline key strings are accepted only for explicit programmatic/test use
 *     and are rejected from file configuration
 *   - resolved key values are never copied into logs, diagnostics or errors
 *   - prototype-pollution keys are rejected
 *
 * Errors identify the configuration path; they never quote secret values.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { deepFreeze } from '../models/registry.js';
import { validateFileConfig } from './validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = join(__dirname, '..', '..', 'config', '7proxy.json');

/** A referenced environment variable must exist and be non-empty. */
function resolveKeyRefs(keyEntries, providerId, configPath, seen) {
  const resolved = [];
  for (const entry of keyEntries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${configPath}: provider '${providerId}': each key entry must be an object with an "env" field`);
    }
    const envName = entry.env;
    if (typeof envName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error(`${configPath}: provider '${providerId}': key entry must reference an environment variable name ("env")`);
    }
    const value = process.env[envName];
    if (typeof value !== 'string' || value === '') {
      // Never echo the variable's (missing) value; the name is safe to print.
      throw new Error(`${configPath}: provider '${providerId}': environment variable '${envName}' is not set (referenced by a key entry)`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      resolved.push(value);
    }
  }
  return resolved;
}

/**
 * Load a JSON config file and map it to the internal provider/config shape.
 * @returns {object} { config } with frozen provider entries
 */
export function loadJsonConfig(configPath) {
  const path = resolve(configPath);
  if (!existsSync(path)) {
    throw new Error(`configuration file not found: ${path}`);
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    throw new Error(`configuration file could not be read: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`configuration file contains invalid JSON: ${path}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`configuration file must contain a JSON object: ${path}`);
  }

  // Semantic validation (throws with the config path in every message).
  const clean = validateFileConfig(parsed, path);

  // Resolve keys from the environment (after validation, before freezing).
  const providers = [];
  for (const [id, spec] of Object.entries(clean.providers)) {
    const seen = new Set();
    const apiKeys = resolveKeyRefs(spec.keys ?? [], id, path, seen);
    if (apiKeys.length === 0) {
      throw new Error(`${path}: provider '${id}' has no usable API keys (all referenced variables resolved to duplicates or nothing)`);
    }
    providers.push({
      name: id,
      providerType: spec.type,
      baseUrl: spec.baseUrl,
      apiKeys,
      models: [...spec.models],
      capabilities: spec.capabilities
    });
  }
  deepFreeze(providers);

  return {
    providers,
    models: clean.models,
    aliases: clean.aliases,
    groups: clean.groups,
    configPath: path
  };
}

/**
 * True when a JSON configuration file should be consulted.
 * A config file is used when SEVEN_PROXY_CONFIG points at a file (explicit),
 * or when config/7proxy.json exists.
 */
export function jsonConfigRequested() {
  return process.env.SEVEN_PROXY_CONFIG !== undefined && process.env.SEVEN_PROXY_CONFIG !== '';
}

export function defaultConfigExists() {
  return existsSync(DEFAULT_CONFIG_PATH);
}

/** Resolve the effective config file path (explicit override or default). */
export function resolveConfigPath() {
  const override = process.env.SEVEN_PROXY_CONFIG;
  if (override && override !== '') return resolve(override);
  return DEFAULT_CONFIG_PATH;
}

export default { loadJsonConfig, resolveConfigPath, defaultConfigExists, jsonConfigRequested };