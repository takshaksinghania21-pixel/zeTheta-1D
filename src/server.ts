import 'dotenv/config';
import http from 'node:http';
import { createApp } from './app';
import { enableDefaultMetrics } from './common/metrics';
import { setRootLogger } from './common/logger';
import { loadConfig } from './config/env';
import { Container } from './container';
import { attachSocketIo } from './socket';
import { startWorkers, stopWorkers } from './workers/main';
import { ensureInfrastructure } from './workers/bootstrap';

async function main(): Promise<void> {
  const config = loadConfig();
  const c = new Container(config);
  setRootLogger(c.logger);
  enableDefaultMetrics(config.SERVICE_NAME);
  await ensureInfrastructure(c);

  let shuttingDown = false;
  const { app } = createApp(c, { isShuttingDown: () => shuttingDown });
  const server = http.createServer(app);
  const io = attachSocketIo(server, c);
  // Optional single-process mode for local development (RUN_WORKERS=all or a list).
  const embedded = process.env.RUN_WORKERS
    ? await startWorkers(
        c,
        process.env.RUN_WORKERS === 'all'
          ? ['outbox-relay', 'event-consumer', 'dispatcher', 'dlq-ingest', 'scheduler', 'analytics']
          : (process.env.RUN_WORKERS.split(',') as never[]),
      )
    : [];

  server.listen(config.PORT, () => {
    c.logger.info(
      { port: config.PORT, embeddedWorkers: embedded.map((w) => w.name) },
      'API listening',
    );
  });
  server.keepAliveTimeout = 65000;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true; // readiness now reports 503 so load balancers drain traffic
    c.logger.info({ signal }, 'graceful shutdown started');
    const force = setTimeout(() => process.exit(1), 30000);
    force.unref();
    await new Promise((r) => setTimeout(r, Number(process.env.SHUTDOWN_DRAIN_MS ?? 2000)));
    await io.close(); // closes sockets and the underlying HTTP server
    await stopWorkers(c, embedded);
    await c.close();
    c.logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `API startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
