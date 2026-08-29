#!/usr/bin/env node
/**
 * AI Proxy - Production-ready OpenAI-compatible proxy
 * Entry point
 */

import { loadConfig } from './config.js';
import { ProviderRegistry } from './providers/index.js';
import { createRouter } from './router.js';
import { createServer } from './server.js';
import { logger } from './logger.js';

async function main() {
  try {
    // Load configuration
    const config = loadConfig();

    // Create provider registry
    const registry = new ProviderRegistry(config.providers, config.defaultProvider);

    // Create router
    const router = createRouter(config, registry);

    // Create and start server
    const server = createServer(config, router);
    await server.start();

  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

main();
