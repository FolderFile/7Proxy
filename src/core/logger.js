/**
 * Lightweight structured logger. Never logs secrets.
 * Reads LOG_LEVEL at module load; tests set it before importing server modules.
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

const SENSITIVE_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'x-auth-token',
  'cookie', 'set-cookie', 'proxy-authorization'
]);

function redactHeaders(headers) {
  if (!headers) return {};
  const clean = {};
  for (const [key, value] of Object.entries(headers)) {
    clean[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return clean;
}

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] > CURRENT_LEVEL) return;
  const entry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message
  };
  // Only allow safe, non-secret metadata keys.
  for (const k of ['requestId', 'provider', 'model', 'statusCode', 'durationMs',
    'errorCode', 'retryCount', 'attempt', 'keyIndex', 'keyCount']) {
    if (meta[k] !== undefined) entry[k] = meta[k];
  }
  // Sanitized error string only (no stack traces in production responses).
  if (meta.error) {
    entry.error = typeof meta.error === 'string' ? meta.error : String(meta.error);
  }
  if (meta.stack && CURRENT_LEVEL >= LOG_LEVELS.debug) entry.stack = meta.stack;
  if (CURRENT_LEVEL >= LOG_LEVELS.debug && meta.headers) entry.headers = redactHeaders(meta.headers);
  console.log(JSON.stringify(entry));
}

export const logger = {
  error: (msg, meta) => log('error', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  debug: (msg, meta) => log('debug', msg, meta)
};

export default logger;
