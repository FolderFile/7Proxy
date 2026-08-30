#!/usr/bin/env node
/**
 * AI Proxy - Production-ready OpenAI-compatible proxy
 * Entry point
 */

import { loadConfig } from './core/config.js';
import { ProviderRegistry } from './providers/index.js';
import { buildRoutingRegistry, buildFileModeProviders } from './models/routing-utils.js';
import { createRouter } from './core/router.js';
import { createServer } from './server.js';
import { logger } from './core/logger.js';

async function main() {
  try {
    // Load configuration (JSON file when present/requested, env otherwise)
    const config = loadConfig();

    // Create provider objects from the file config via the adapter registry,
    // or the legacy env-only providers as before.
    let providers;
    if (config.fileConfig) {
      providers = buildFileModeProviders(config);
    } else {
      providers = new ProviderRegistry(config.providers, config.defaultProvider);
    }

    // Immutable public-name routing registry (aliases/groups; null = env-only).
    const routingRegistry = buildRoutingRegistry(config, providers);

    // Create router (the routing registry, when present, drives model routing)
    const router = createRouter(config, providers, routingRegistry);

    // Create and start server
    const server = createServer(config, router);
    await server.start();

  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
}

main();