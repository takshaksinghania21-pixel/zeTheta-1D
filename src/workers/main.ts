import 'dotenv/config';
import http from 'node:http';
import { Container } from '../container';
import { enableDefaultMetrics, registry } from '../common/metrics';
import { setRootLogger } from '../common/logger';
import { loadConfig } from '../config/env';
import { CHANNELS, isChannel, type Channel } from '../domain/types';
import { ensureInfrastructure } from './bootstrap';
import {
  startAnalytics,
  startDispatcher,
  startDlqIngest,
  startEventConsumer,
  startOutboxRelay,
  startScheduler,
  type RunningWorker,
} from './workers';

const ALL = [
  'event-consumer',
  'dispatcher',
  'dlq-ingest',
  'outbox-relay',
  'scheduler',
  'analytics',
] as const;
type WorkerName = (typeof ALL)[number];

export async function startWorkers(
  c: Container,
  names: readonly WorkerName[],
  channels: readonly Channel[] = CHANNELS,
): Promise<RunningWorker[]> {
  await ensureInfrastructure(c);
  const started: RunningWorker[] = [];
  for (const name of names) {
    switch (name) {
      case 'outbox-relay':
        started.push(await startOutboxRelay(c));
        break;
      case 'event-consumer':
        started.push(await startEventConsumer(c));
        break;
      case 'dispatcher':
        started.push(await startDispatcher(c, channels));
        break;
      case 'dlq-ingest':
        started.push(await startDlqIngest(c));
        break;
      case 'scheduler':
        started.push(startScheduler(c));
        break;
      case 'analytics':
        started.push(await startAnalytics(c));
        break;
    }
  }
  return started;
}

/** Stops consumers first (no new work), then relays/schedulers, then connections. */
export async function stopWorkers(c: Container, workers: RunningWorker[]): Promise<void> {
  for (const w of [...workers].reverse()) {
    try {
      await w.stop();
    } catch (err) {
      c.logger.warn({ err, worker: w.name }, 'worker stop failed');
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const c = new Container(config);
  setRootLogger(c.logger);
  enableDefaultMetrics(`${config.SERVICE_NAME}-worker`);
  const requested = (process.env.WORKERS ?? process.argv[2] ?? 'all')
    .split(',')
    .map((s) => s.trim());
  const names = requested.includes('all')
    ? [...ALL]
    : requested.filter((n): n is WorkerName => (ALL as readonly string[]).includes(n));
  const channels = (process.env.DISPATCH_CHANNELS ?? '').split(',').filter(isChannel);
  const workers = await startWorkers(c, names, channels.length > 0 ? channels : CHANNELS);
  let ready = true;

  const server = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      void registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType });
        res.end(body);
      });
    } else if (req.url === '/health/live') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'ok' }));
    } else if (req.url === '/health/ready') {
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: ready ? 'ready' : 'stopping',
          workers: workers.map((w) => w.name),
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(config.METRICS_PORT, () => {
    c.logger.info(
      { port: config.METRICS_PORT, workers: workers.map((w) => w.name) },
      'workers started',
    );
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ready = false;
    c.logger.info({ signal }, 'graceful shutdown started');
    const force = setTimeout(() => {
      c.logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 30000);
    force.unref();
    await stopWorkers(c, workers);
    server.close();
    await c.close();
    c.logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `worker startup failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(1);
  });
}
