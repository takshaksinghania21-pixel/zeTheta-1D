/**
 * Reproducible development benchmark driver:
 *  1. seeds N synthetic benchmark users (quiet hours off, push/email/inapp),
 *  2. runs the k6 ingestion test (EVENTS events),
 *  3. waits until every event is processed and every notification has left
 *     QUEUED, measuring end-to-end processing throughput and latency from the DB,
 *  4. writes reports/benchmark.json.
 * Requires API + workers running (e.g. RUN_WORKERS=all node dist/src/server.js).
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config/env';
import { Container } from '../src/container';

const EVENTS = Number(process.env.EVENTS ?? 10000);
const VUS = Number(process.env.VUS ?? 50);
const USERS = Number(process.env.BENCH_USERS ?? 200);

async function main(): Promise<void> {
  const c = new Container(loadConfig());
  const creds = JSON.parse(readFileSync('.local/seed-credentials.json', 'utf8')) as {
    service: { clientId: string; clientSecret: string };
  };
  const run = `${Date.now()}`;
  const ids: string[] = [];
  for (let i = 0; i < USERS; i++) {
    const u = await c.users().create({
      externalRef: `bench-${run}-${i}`,
      displayName: `Bench ${i}`,
      timezone: 'UTC',
      contacts: [
        { channel: 'email', value: `bench-${run}-${i}@example.test` },
        { channel: 'push', value: `fcm-bench-${run}-${i}-000000000000` },
      ],
    });
    await c
      .users()
      .updatePreferences(
        u.id,
        (p) => ({ ...p, quietHours: { enabled: false, start: '21:00', end: '08:00' } }),
        'benchmark',
      );
    ids.push(u.id);
  }
  const started = new Date();
  const k6Out = execFileSync(
    'k6',
    [
      'run',
      '--summary-export',
      'reports/k6-ingestion-summary.json',
      '-e',
      `BASE_URL=${process.env.BASE_URL ?? 'http://localhost:3000'}`,
      '-e',
      `CLIENT_ID=${creds.service.clientId}`,
      '-e',
      `CLIENT_SECRET=${creds.service.clientSecret}`,
      '-e',
      `USER_IDS=${ids.join(',')}`,
      '-e',
      `EVENTS=${EVENTS}`,
      '-e',
      `VUS=${VUS}`,
      '-e',
      `RUN_ID=${run}`,
      'load-tests/ingestion.js',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const ingestDone = new Date();
  writeFileSync('reports/k6-ingestion-output.txt', k6Out);

  const db = c.db();
  const userFilter = db('users').select('id').where('external_ref', 'like', `bench-${run}-%`);
  let processed = 0;
  let pending = 0;
  const deadline = Date.now() + 15 * 60000;
  do {
    await new Promise((r) => setTimeout(r, 2000));
    const [p] = (await db('financial_events')
      .whereIn('user_id', userFilter)
      .where('status', 'PROCESSED')
      .count({ n: '*' })) as { n: string }[];
    const [q] = (await db('notifications')
      .whereIn('user_id', userFilter)
      .whereIn('state', ['CREATED', 'ENRICHED', 'ROUTED', 'QUEUED', 'RETRYING'])
      .count({ n: '*' })) as { n: string }[];
    processed = Number(p?.n ?? 0);
    pending = Number(q?.n ?? 0);
  } while ((processed < EVENTS || pending > 0) && Date.now() < deadline);
  const finished = new Date();

  const stats = (await db.raw(
    `SELECT count(*)::int AS notifications,
            count(*) FILTER (WHERE state IN ('SENT','DELIVERED','READ'))::int AS sent,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at) * 1000) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at) * 1000) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at) * 1000) AS p99,
            min(created_at) AS first_created, max(sent_at) AS last_sent
       FROM notifications WHERE user_id IN (SELECT id FROM users WHERE external_ref LIKE ?)`,
    [`bench-${run}-%`],
  )) as { rows: Record<string, unknown>[] };
  const eventLatency = (await db.raw(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - received_at) * 1000) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - received_at) * 1000) AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - received_at) * 1000) AS p99
       FROM financial_events WHERE user_id IN (SELECT id FROM users WHERE external_ref LIKE ?)`,
    [`bench-${run}-%`],
  )) as { rows: Record<string, unknown>[] };
  const k6 = JSON.parse(readFileSync('reports/k6-ingestion-summary.json', 'utf8')) as {
    metrics: Record<string, Record<string, number>>;
    setup_data?: unknown;
  };
  // k6 embeds setup() return values (the access token) in the summary: never persist it.
  delete k6.setup_data;
  writeFileSync('reports/k6-ingestion-summary.json', JSON.stringify(k6, null, 2));
  const totalSeconds = (finished.getTime() - started.getTime()) / 1000;
  const report = {
    runAt: started.toISOString(),
    environment: {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
      os: `${platform()} ${release()}`,
      node: process.version,
      topology:
        'single host: API + all workers in ONE Node process (RUN_WORKERS=all), PostgreSQL 16, Redis 8, Kafka 4.3 (1 broker), RabbitMQ 4.3, mock providers',
    },
    parameters: {
      events: EVENTS,
      vus: VUS,
      users: USERS,
      eventType: 'TXNX-001 (push+email+inapp → 3 notifications/event)',
    },
    ingestion: {
      wallSeconds: (ingestDone.getTime() - started.getTime()) / 1000,
      httpRequests: k6.metrics.http_reqs?.count,
      httpRequestsPerSecond: k6.metrics.http_reqs?.rate,
      httpFailedRate: k6.metrics.http_req_failed?.value ?? k6.metrics.http_req_failed?.rate,
      httpDurationMs: {
        p50: k6.metrics.http_req_duration?.med,
        p95: k6.metrics.http_req_duration?.['p(95)'],
        p99: k6.metrics.http_req_duration?.['p(99)'],
        max: k6.metrics.http_req_duration?.max,
      },
      eventsAccepted: k6.metrics.events_accepted?.count,
      eventsRejected: k6.metrics.events_rejected?.count ?? 0,
    },
    processing: {
      eventsProcessed: processed,
      notificationsStillPending: pending,
      totalSecondsUntilDrained: totalSeconds,
      endToEndEventsPerSecond: processed / totalSeconds,
      eventProcessingLatencyMs: eventLatency.rows[0],
      notifications: stats.rows[0],
    },
  };
  writeFileSync('reports/benchmark.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await c.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
