/**
 * EXPLAIN (ANALYZE, BUFFERS) evidence for the daily delivery-rate report (PDF §A12 Q5,
 * Day 11). Read-only: only SELECT statements are explained. Writes
 * reports/explain-delivery-rate.txt with the data volume the plans were taken on.
 * Usage: `npm run explain` (uses DATABASE_URL).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import knex from 'knex';

const QUERIES: Record<string, string> = {
  'Daily delivery rate by channel (raw notifications, partition-pruned by created_at)': `
    SELECT date_trunc('day', created_at) AS day, channel,
           count(*) FILTER (WHERE sent_at IS NOT NULL)      AS sent,
           count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
           round(count(*) FILTER (WHERE delivered_at IS NOT NULL)::numeric
                 / NULLIF(count(*) FILTER (WHERE sent_at IS NOT NULL), 0), 4) AS delivery_rate
    FROM notifications
    WHERE created_at >= date_trunc('day', now()) - interval '1 day'
      AND created_at <  date_trunc('day', now()) + interval '1 day'
    GROUP BY 1, 2 ORDER BY 1, 2`,
  'Daily delivery rate by event type (index on event_type, created_at)': `
    SELECT event_type, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered, count(*) AS total
    FROM notifications
    WHERE event_type = 'TXNX-001' AND created_at >= now() - interval '1 day'
    GROUP BY 1`,
  'Last 15 minutes by channel (narrow time range: index on created_at / BRIN)': `
    SELECT channel, count(*) FROM notifications
    WHERE created_at >= now() - interval '15 minutes'
    GROUP BY 1`,
  'Same report from the hourly aggregate maintained by the analytics consumer (CQRS read model)': `
    SELECT date_trunc('day', bucket) AS day, channel,
           sum(value) FILTER (WHERE metric = 'sent')      AS sent,
           sum(value) FILTER (WHERE metric = 'delivered') AS delivered
    FROM analytics_hourly
    WHERE bucket >= date_trunc('day', now()) - interval '1 day'
    GROUP BY 1, 2 ORDER BY 1, 2`,
  'Per-user notification list (composite index user_id, state, channel)': `
    SELECT id, channel, state, created_at FROM notifications
    WHERE user_id = (SELECT user_id FROM notifications LIMIT 1) AND state = 'DELIVERED' AND channel = 'push'
    ORDER BY created_at DESC LIMIT 20`,
};

async function main(): Promise<void> {
  const db = knex({ client: 'pg', connection: process.env.DATABASE_URL });
  try {
    const counts = (await db.raw(`
      SELECT (SELECT count(*) FROM notifications) AS notifications,
             (SELECT count(*) FROM analytics_hourly) AS analytics_hourly,
             (SELECT count(*) FROM pg_inherits WHERE inhparent = 'notifications'::regclass) AS partitions,
             version() AS pg`)) as { rows: Record<string, string>[] };
    const out = [
      `# EXPLAIN (ANALYZE, BUFFERS) — generated ${new Date().toISOString()}`,
      `# Data volume: ${JSON.stringify(counts.rows[0])}`,
      '# Single-machine development database; plans and timings change with volume.',
      '',
    ];
    for (const [title, sql] of Object.entries(QUERIES)) {
      const plan = (await db.raw(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`)) as {
        rows: { 'QUERY PLAN': string }[];
      };
      out.push(`## ${title}`, sql.trim(), '', ...plan.rows.map((r) => r['QUERY PLAN']), '');
    }
    writeFileSync('reports/explain-delivery-rate.txt', out.join('\n'));
    process.stdout.write('reports/explain-delivery-rate.txt written\n');
  } finally {
    await db.destroy();
  }
}

void main();
