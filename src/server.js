/**
 * HTTP server with hardening and graceful shutdown.
 */

import http from 'http';
import { logger } from './core/logger.js';

export function createServer(config, router) {
  const server = http.createServer({
    // Reject headers that arrive slower than this (protects against slowloris).
    // Node will reset the socket if headers aren't received in time.
    keepAliveTimeout: Math.min(config.requestTimeoutMs, 30000),
    headersTimeout: Math.min(config.requestTimeoutMs, 65000),
    requestTimeout: config.requestTimeoutMs,
    // Cap the size of request headers.
    maxHeaderSize: 16384
  }, router);

  let isShuttingDown = false;
  const connections = new Set();
  const activeRequests = new Set(); // AbortControllers for active upstream work

  server.on('connection', (conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
  });

  // Allow the router to register/clear active request abort controllers.
  server.trackRequest = (ctrl) => {
    activeRequests.add(ctrl);
    return () => activeRequests.delete(ctrl);
  };

  function shutdown(signal) {
    return () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      logger.info('Graceful shutdown started', { signal, activeRequests: activeRequests.size });

      // Stop accepting new connections.
      server.close(() => {
        logger.info('Server closed');
        process.exit(0);
      });

      // Abort all active upstream requests so they don't hang shutdown.
      for (const ctrl of activeRequests) {
        try { ctrl.abort(); } catch {}
      }

      // Wait up to the configured deadline, then force-close sockets.
      const forceTimer = setTimeout(() => {
        logger.warn('Forced shutdown after deadline', { activeRequests: activeRequests.size });
        for (const conn of connections) {
          try { conn.destroy(); } catch {}
        }
        process.exit(1);
      }, config.shutdownTimeoutMs);
      forceTimer.unref();

      // Gently end idle keep-alive connections.
      for (const conn of connections) {
        try { conn.end(); } catch {}
      }
    };
  }

  // Attach signal handlers once. Avoid duplicate registration in tests by
  // removing any previous listeners we added.
  const signals = ['SIGTERM', 'SIGINT'];
  for (const s of signals) {
    process.removeAllListeners(s);
    process.on(s, shutdown(s));
  }

  // Log but do not crash on unhandled rejections; rejections from the request
  // path are already caught. This is a safety net only.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { error: String(reason) });
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(config.port, config.host, () => {
          logger.info('Server started', { host: config.host, port: config.port, env: config.nodeEnv });
          resolve(server);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

export default createServer;
