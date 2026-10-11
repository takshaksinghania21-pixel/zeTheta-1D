import type { Knex } from 'knex';
import type { LifecycleEvent } from '../notifications/types';

const METRIC_FOR_STATE: Record<string, string> = {
  CREATED: 'created',
  QUEUED: 'queued',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  CLICKED: 'clicked',
  FAILED: 'failed',
  BOUNCED: 'bounced',
  DLQ: 'dlq',
  RETRYING: 'retries',
  CAPPED: 'capped',
  QUIET: 'quiet',
  DND: 'dnd',
  SUPPRESSED: 'suppressed',
  DIGESTED: 'digested',
};

export interface TimeRange {
  from: Date;
  to: Date;
}

/**
 * Near-real-time analytics. Lifecycle events from Kafka are folded into hourly
 * aggregates exactly once per transition (dedupe table in the same transaction).
 * Latency percentiles are computed from recorded timestamps with percentile_cont.
 */
export class AnalyticsService {
  constructor(private readonly db: Knex) {}

  /** Returns false when the event was already counted (redelivery). */
  async ingest(e: LifecycleEvent): Promise<boolean> {
    const metric = METRIC_FOR_STATE[e.to];
    if (!metric) return false;
    return this.db.transaction(async (trx) => {
      const inserted = (await trx('analytics_processed')
        .insert({ transition_id: e.transitionId })
        .onConflict('transition_id')
        .ignore()
        .returning('transition_id')) as unknown[];
      if (inserted.length === 0) return false;
      const bucket = new Date(e.at);
      bucket.setUTCMinutes(0, 0, 0);
      const rows = [{ bucket, channel: e.channel, event_type: e.eventType, metric, value: 1 }];
      if (e.to === 'SENT' && e.costMicros)
        rows.push({
          bucket,
          channel: e.channel,
          event_type: e.eventType,
          metric: 'cost_micros',
          value: e.costMicros,
        });
      for (const r of rows) {
        await trx('analytics_hourly')
          .insert(r)
          .onConflict(['bucket', 'channel', 'event_type', 'metric'])
          .merge({ value: trx.raw('analytics_hourly.value + EXCLUDED.value') });
      }
      return true;
    });
  }

  private async counts(
    range: TimeRange,
    groupBy: 'channel' | 'event_type',
  ): Promise<Map<string, Record<string, number>>> {
    const rows = (await this.db('analytics_hourly')
      .where('bucket', '>=', range.from)
      .andWhere('bucket', '<', range.to)
      .groupBy(groupBy, 'metric')
      .select(`${groupBy} as key`, 'metric')
      .sum({ value: 'value' })) as { key: string; metric: string; value: string }[];
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const m = out.get(r.key) ?? {};
      m[r.metric] = Number(r.value);
      out.set(r.key, m);
    }
    return out;
  }

  /** Delivery rate = delivered / sent (provider-confirmed); acceptance rate = sent / queued. */
  async deliveryRates(
    range: TimeRange,
    groupBy: 'channel' | 'event_type',
  ): Promise<Record<string, unknown>[]> {
    const counts = await this.counts(range, groupBy);
    return [...counts.entries()].map(([key, m]) => ({
      [groupBy === 'channel' ? 'channel' : 'eventType']: key,
      queued: m.queued ?? 0,
      sent: m.sent ?? 0,
      delivered: m.delivered ?? 0,
      failed: (m.failed ?? 0) + (m.bounced ?? 0),
      dlq: m.dlq ?? 0,
      retries: m.retries ?? 0,
      acceptanceRate: ratio(m.sent, m.queued),
      deliveryRate: ratio(m.delivered, m.sent),
      failureRate: ratio((m.failed ?? 0) + (m.bounced ?? 0) + (m.dlq ?? 0), m.queued),
    }));
  }

  /** Read/open and click-through rates only where the channel can measure them. */
  async engagement(range: TimeRange): Promise<Record<string, unknown>[]> {
    const counts = await this.counts(range, 'channel');
    const measurable: Record<string, { read: boolean; click: boolean; note?: string }> = {
      inapp: { read: true, click: true },
      whatsapp: {
        read: true,
        click: false,
        note: 'read receipts depend on recipient privacy settings',
      },
      push: {
        read: false,
        click: true,
        note: 'FCM provides no open receipts; clicks reported by the app',
      },
      email: {
        read: false,
        click: false,
        note: 'open/click tracking not implemented (no tracking pixel)',
      },
      sms: { read: false, click: false, note: 'SMS has no read receipts' },
    };
    return Object.entries(measurable).map(([channel, cap]) => {
      const m = counts.get(channel) ?? {};
      return {
        channel,
        delivered: m.delivered ?? 0,
        read: cap.read ? (m.read ?? 0) : null,
        clicked: cap.click ? (m.clicked ?? 0) : null,
        readRate: cap.read ? ratio(m.read, (m.delivered ?? 0) + (m.read ?? 0)) : null,
        clickThroughRate: cap.click
          ? ratio(m.clicked, (m.delivered ?? 0) + (m.read ?? 0) || m.sent)
          : null,
        note: cap.note ?? null,
      };
    });
  }

  async latency(range: TimeRange, channel?: string): Promise<Record<string, unknown>[]> {
    const q = this.db('notifications')
      .where('created_at', '>=', range.from)
      .andWhere('created_at', '<', range.to)
      .whereNotNull('sent_at')
      .groupBy('channel')
      .select(
        'channel',
        this.db.raw('count(*)::int AS samples'),
        this.db.raw(
          `percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at) * 1000) AS send_p50_ms`,
        ),
        this.db.raw(
          `percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at) * 1000) AS send_p95_ms`,
        ),
        this.db.raw(
          `percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at) * 1000) AS send_p99_ms`,
        ),
        this.db.raw(
          `percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM delivered_at - created_at) * 1000) FILTER (WHERE delivered_at IS NOT NULL) AS delivery_p50_ms`,
        ),
        this.db.raw(
          `percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM delivered_at - created_at) * 1000) FILTER (WHERE delivered_at IS NOT NULL) AS delivery_p95_ms`,
        ),
        this.db.raw(
          `percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM delivered_at - created_at) * 1000) FILTER (WHERE delivered_at IS NOT NULL) AS delivery_p99_ms`,
        ),
      );
    if (channel) q.where('channel', channel);
    const rows = (await q) as Record<string, string | number | null>[];
    return rows.map((r) => ({
      channel: r.channel,
      samples: Number(r.samples),
      sendLatencyMs: { p50: num(r.send_p50_ms), p95: num(r.send_p95_ms), p99: num(r.send_p99_ms) },
      deliveryLatencyMs: {
        p50: num(r.delivery_p50_ms),
        p95: num(r.delivery_p95_ms),
        p99: num(r.delivery_p99_ms),
      },
    }));
  }

  async failures(range: TimeRange): Promise<Record<string, unknown>> {
    const byProvider = (await this.db('delivery_attempts')
      .where('started_at', '>=', range.from)
      .andWhere('started_at', '<', range.to)
      .groupBy('provider')
      .select(
        'provider',
        this.db.raw('count(*)::int AS attempts'),
        this.db.raw(`count(*) FILTER (WHERE status = 'FAILED')::int AS failed`),
        this.db.raw(`count(*) FILTER (WHERE status = 'UNKNOWN')::int AS unknown`),
      )) as {
      provider: string;
      attempts: number;
      failed: number;
      unknown: number;
    }[];
    const reasons = (await this.db('delivery_attempts')
      .where('started_at', '>=', range.from)
      .andWhere('started_at', '<', range.to)
      .where('status', 'FAILED')
      .groupBy('provider', 'error_kind', 'error_code')
      .select('provider', 'error_kind', 'error_code', this.db.raw('count(*)::int AS count'))
      .orderBy('count', 'desc')
      .limit(50)) as Record<string, unknown>[];
    return {
      byProvider: byProvider.map((p) => ({ ...p, failureRate: ratio(p.failed, p.attempts) })),
      topReasons: reasons,
    };
  }

  /** Rolling 30-day opt-out rate = distinct users who opted out / users. */
  async optOuts(now: Date): Promise<Record<string, unknown>> {
    const since = new Date(now.getTime() - 30 * 86400000);
    const [optedOut] = (await this.db('opt_out_events')
      .where('created_at', '>=', since)
      .countDistinct({ n: 'user_id' })) as { n: string }[];
    const [users] = (await this.db('users')
      .whereNot({ status: 'ANONYMIZED' })
      .count({ n: '*' })) as { n: string }[];
    const byChannel = (await this.db('opt_out_events')
      .where('created_at', '>=', since)
      .groupBy('channel')
      .select('channel')
      .countDistinct({ users: 'user_id' })) as Record<string, unknown>[];
    return {
      windowDays: 30,
      optedOutUsers: Number(optedOut?.n ?? 0),
      totalUsers: Number(users?.n ?? 0),
      optOutRate: ratio(Number(optedOut?.n ?? 0), Number(users?.n ?? 0)),
      byChannel,
    };
  }

  async costs(range: TimeRange): Promise<Record<string, unknown>[]> {
    const counts = await this.counts(range, 'channel');
    return [...counts.entries()].map(([channel, m]) => ({
      channel,
      totalCostMicros: m.cost_micros ?? 0,
      delivered: m.delivered ?? 0,
      sent: m.sent ?? 0,
      costPerDeliveredMicros: m.delivered ? Math.round((m.cost_micros ?? 0) / m.delivered) : null,
      costPerSentMicros: m.sent ? Math.round((m.cost_micros ?? 0) / m.sent) : null,
    }));
  }

  /** Cap hit rate = capped / notifications that reached a routing decision. */
  async frequencyCaps(range: TimeRange): Promise<Record<string, unknown>> {
    const counts = await this.counts(range, 'channel');
    let capped = 0;
    let decided = 0;
    for (const m of counts.values()) {
      capped += m.capped ?? 0;
      decided += (m.queued ?? 0) + (m.capped ?? 0) + (m.quiet ?? 0) + (m.digested ?? 0);
    }
    const [suggestions] = (await this.db('digest_suggestions')
      .whereNull('dismissed_at')
      .count({ n: '*' })) as { n: string }[];
    return {
      capped,
      routed: decided,
      capHitRate: ratio(capped, decided),
      digestSuggestionsOpen: Number(suggestions?.n ?? 0),
    };
  }

  async summary(range: TimeRange, now: Date): Promise<Record<string, unknown>> {
    const [byChannel, latency, failures, engagement, optOuts, costs, caps, dlq, lagRow] =
      await Promise.all([
        this.deliveryRates(range, 'channel'),
        this.latency(range),
        this.failures(range),
        this.engagement(range),
        this.optOuts(now),
        this.costs(range),
        this.frequencyCaps(range),
        this.db('dead_letter_entries').where({ status: 'OPEN' }).count({ n: '*' }),
        this.db('analytics_processed').max({ at: 'processed_at' }).first(),
      ]);
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      deliveryByChannel: byChannel,
      latency,
      failures,
      engagement,
      optOuts,
      costs,
      frequencyCaps: caps,
      dlqOpen: Number((dlq as { n: string }[])[0]?.n ?? 0),
      lastAggregatedAt: (lagRow as { at: Date | null } | undefined)?.at ?? null,
    };
  }
}

function ratio(a: number | undefined, b: number | undefined): number | null {
  if (!b) return null;
  return Math.round(((a ?? 0) / b) * 10000) / 10000;
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.round(Number(v) * 100) / 100;
}
