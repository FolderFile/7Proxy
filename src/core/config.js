/**
 * Configuration management with startup validation.
 */

import { logger } from './logger.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Project root: two levels above src/core/. Portable across OSes. */
const PROJECT_ROOT = join(__dirname, '..', '..');

function parseEnvFile() {
  const envPath = join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return;
  let content;
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch {
    return;
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function intEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function parseKeys(keyString) {
  if (!keyString) return [];
  return keyString
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0 && !k.toLowerCase().includes('your-key'));
}

function isValidUrl(u) {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function loadConfig() {
  parseEnvFile();

  const config = {
    port: intEnv('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'production',
    proxyApiKey: process.env.PROXY_API_KEY || null,

    maxRequestBodySize: intEnv('MAX_REQUEST_BODY_SIZE', 1024 * 1024),
    requestTimeoutMs: intEnv('REQUEST_TIMEOUT_MS', 60000),
    streamTimeoutMs: intEnv('STREAM_TIMEOUT_MS', 300000),
    // Hard cap for a single streaming exchange (0 disables). Guards against
    // slow-trickle upstreams that stay under the inactivity threshold.
    streamOverallTimeoutMs: intEnv('STREAM_OVERALL_TIMEOUT_MS', 300000),

    // Total upstream attempts per client request (first attempt + retries).
    maxAttempts: intEnv('MAX_ATTEMPTS', intEnv('MAX_RETRIES', 3) + 1),
    retryBaseDelayMs: intEnv('RETRY_DELAY_MS', 500),
    retryMaxDelayMs: intEnv('RETRY_MAX_DELAY_MS', 5000),
    keyCooldownMs: intEnv('KEY_COOLDOWN_MS', 60000),

    // Graceful shutdown deadline for active requests.
    shutdownTimeoutMs: intEnv('SHUTDOWN_TIMEOUT_MS', 10000),

    corsOrigin: process.env.CORS_ORIGIN || '*',
    corsMethods: process.env.CORS_METHODS || 'GET,POST,OPTIONS',
    corsHeaders: process.env.CORS_HEADERS || 'Content-Type, Authorization, Accept',

    defaultProvider: process.env.DEFAULT_PROVIDER || 'openai',
    providers: []
  };

  const providers = [];

  /**
   * Per-provider capability overrides from env:
   *   <NAME>_CAPABILITIES = comma-separated key=value pairs, e.g.
   *   "responses=native,reasoning=true,previousResponseId=true"
   * Recognized keys: responses (native|translated|unsupported), reasoning,
   * previousResponseId, store, truncation, textFormat, tools, vision,
   * serviceTier, metadata.
   */
  function capabilitiesFromEnv(name) {
    const envKey = `${name.toUpperCase()}_CAPABILITIES`;
    const raw = process.env[envKey];
    if (!raw) return undefined;
    const caps = {};
    for (const part of raw.split(',')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      if (!k) continue;
      if (v === 'true' || v === 'false') v = v === 'true';
      // camelCase the env-style keys (previousResponseId etc. pass through).
      caps[k.charAt(0).toLowerCase() + k.slice(1)] = v;
    }
    return caps;
  }

  // OpenAI-compatible provider (also used for any OpenAI-compatible upstream).
  const openaiKeys = parseKeys(process.env.OPENAI_API_KEYS);
  if (openaiKeys.length > 0) {
    providers.push({
      name: 'openai',
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com',
      apiKeys: openaiKeys,
      models: (process.env.OPENAI_MODELS || 'gpt-4o,gpt-4o-mini,gpt-4-turbo,gpt-4,gpt-3.5-turbo')
        .split(',').map(s => s.trim()).filter(Boolean),
      capabilities: capabilitiesFromEnv('openai')
    });
  }

  // Anthropic (optional, OpenAI-compatible endpoint variant if configured).
  const anthropicKeys = parseKeys(process.env.ANTHROPIC_API_KEYS);
  if (anthropicKeys.length > 0) {
    providers.push({
      name: 'anthropic',
      baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      apiKeys: anthropicKeys,
      models: (process.env.ANTHROPIC_MODELS || 'claude-3-5-sonnet-20241022,claude-3-5-haiku-20241022,claude-3-opus-20240229')
        .split(',').map(s => s.trim()).filter(Boolean),
      capabilities: capabilitiesFromEnv('anthropic')
    });
  }

  // Second OpenAI-compatible provider for failover testing/config.
  const altKeys = parseKeys(process.env.ALT_API_KEYS);
  if (altKeys.length > 0) {
    providers.push({
      name: 'alt',
      baseUrl: process.env.ALT_BASE_URL,
      apiKeys: altKeys,
      models: (process.env.ALT_MODELS || 'gpt-4o')
        .split(',').map(s => s.trim()).filter(Boolean),
      capabilities: capabilitiesFromEnv('alt')
    });
  }

  config.providers = providers;
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  const errs = [];

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errs.push('PORT must be an integer between 1 and 65535');
  }
  if (config.maxRequestBodySize < 1) errs.push('MAX_REQUEST_BODY_SIZE must be positive');
  if (config.requestTimeoutMs < 100) errs.push('REQUEST_TIMEOUT_MS must be at least 100ms');
  if (config.streamTimeoutMs < 100) errs.push('STREAM_TIMEOUT_MS must be at least 100ms');
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts < 1 || config.maxAttempts > 20) {
    errs.push('MAX_ATTEMPTS must be an integer between 1 and 20');
  }
  if (config.retryBaseDelayMs < 0) errs.push('RETRY_DELAY_MS must be non-negative');
  if (config.retryMaxDelayMs < config.retryBaseDelayMs) errs.push('RETRY_MAX_DELAY_MS must be >= RETRY_DELAY_MS');
  if (config.keyCooldownMs < 0) errs.push('KEY_COOLDOWN_MS must be non-negative');
  if (config.streamOverallTimeoutMs < 0) errs.push('STREAM_OVERALL_TIMEOUT_MS must be non-negative');
  if (config.shutdownTimeoutMs < 100) errs.push('SHUTDOWN_TIMEOUT_MS must be at least 100ms');

  if (config.proxyApiKey !== null && config.proxyApiKey.length === 0) {
    errs.push('PROXY_API_KEY must not be empty when set');
  }

  if (config.providers.length === 0) {
    errs.push('No providers configured. Set at least one *_API_KEYS environment variable.');
  }

  const seenModels = new Map();
  for (const p of config.providers) {
    if (!p.name) errs.push('Provider missing name');
    if (!isValidUrl(p.baseUrl)) errs.push(`Provider ${p.name || '?'} has invalid baseUrl`);
    if (p.apiKeys.length === 0) errs.push(`Provider ${p.name} has no API keys`);
    for (const m of p.models) {
      if (seenModels.has(m)) {
        // Duplicates are allowed: they are how cross-provider failover is
        // configured (same model served by a backup provider). Log, don't fail.
        logger.warn('Duplicate model across providers (intentional for failover)', {
          error: `model=${m} providers=${seenModels.get(m)},${p.name}` });
      } else {
        seenModels.set(m, p.name);
      }
    }
  }

  // Validate default provider exists.
  if (config.providers.length > 0 && !config.providers.some(p => p.name === config.defaultProvider)) {
    errs.push(`DEFAULT_PROVIDER '${config.defaultProvider}' is not a configured provider`);
  }

  if (errs.length > 0) {
    // Print each error on its own line; never include secret values here.
    for (const e of errs) logger.error('Config validation error', { error: e });
    logger.error('Configuration invalid, exiting', { errorCount: errs.length });
    process.exit(1);
  }

  logger.info('Configuration loaded', {
    port: config.port,
    host: config.host,
    providers: config.providers.map(p => p.name),
    models: config.providers.reduce((s, p) => s + p.models.length, 0),
    maxAttempts: config.maxAttempts
  });
}

export default loadConfig;
