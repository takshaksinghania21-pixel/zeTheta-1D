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

  /** PDF Appendix A `GET /analytics/delivery-rates` body (p.64–65). */
  async pdfDeliveryRates(range: TimeRange, channel?: string): Promise<Record<string, unknown>> {
    const counts = await this.counts(range, 'channel');
    const rows = [...counts.entries()].filter(([ch]) => !channel || ch === channel);
    const sum = (k: string): number => rows.reduce((t, [, m]) => t + (m[k] ?? 0), 0);
    const notif = () => {
      const q = this.db('notifications')
        .where('created_at', '>=', range.from)
        .andWhere('created_at', '<', range.to);
      if (channel) q.where('channel', channel);
      return q;
    };
    const [byPriority, users, dnd] = await Promise.all([
      notif()
        .groupBy('priority')
        .select(
          'priority',
          this.db.raw('count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent'),
          this.db.raw('count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered'),
          this.db.raw(
            `percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM delivered_at - created_at) * 1000) FILTER (WHERE delivered_at IS NOT NULL) AS p99`,
          ),
        ) as Promise<{ priority: string; sent: number; delivered: number; p99: string | null }[]>,
      notif()
        .select(
          this.db.raw('count(DISTINCT user_id)::int AS notified'),
          this.db.raw(`count(DISTINCT user_id) FILTER (WHERE state = 'CAPPED')::int AS capped`),
        )
        .first() as Promise<{ notified: number; capped: number } | undefined>,
      notif()
        .where('state', 'DND')
        .groupBy('regulatory_class')
        .select('regulatory_class', this.db.raw('count(*)::int AS n')) as Promise<
        { regulatory_class: string; n: number }[]
      >,
    ]);
    const dndBy = (cls: string): number => dnd.find((d) => d.regulatory_class === cls)?.n ?? 0;
    const delivered = sum('delivered');
    const costMicros = sum('cost_micros');
    return {
      period: { start: range.from.toISOString(), end: range.to.toISOString() },
      summary: {
        total_sent: sum('sent'),
        total_delivered: delivered,
        total_read: sum('read'),
        overall_delivery_rate: ratio(delivered, sum('sent')),
        overall_read_rate: ratio(sum('read'), delivered),
      },
      by_channel: Object.fromEntries(
        rows.map(([ch, m]) => [
          ch === 'inapp' ? 'in_app' : ch,
          { sent: m.sent ?? 0, delivered: m.delivered ?? 0, rate: ratio(m.delivered, m.sent) },
        ]),
      ),
      by_priority: Object.fromEntries(
        byPriority.map((p) => [
          p.priority,
          {
            sent: p.sent,
            delivered: p.delivered,
            rate: ratio(p.delivered, p.sent),
            p99_latency_ms: num(p.p99),
          },
        ]),
      ),
      frequency_cap_hits: {
        total: sum('capped'),
        percentage_of_users_hitting_cap: ratio(users?.capped, users?.notified),
      },
      dnd_blocks: {
        total: dnd.reduce((t, d) => t + d.n, 0),
        promotional_blocked: dndBy('PROMOTIONAL'),
        transactional_blocked: dndBy('TRANSACTIONAL'),
      },
      cost_summary: {
        total_inr: Math.round(costMicros / 10000) / 100,
        per_notification_avg_paisa: delivered
          ? Math.round(costMicros / delivered / 100) / 100
          : null,
      },
    };
  }

  /** Per-channel delivery, engagement, latency, failure and cost in one view. */
  async channelPerformance(range: TimeRange): Promise<Record<string, unknown>[]> {
    const [rates, engagement, latency, costs] = await Promise.all([
      this.deliveryRates(range, 'channel'),
      this.engagement(range),
      this.latency(range),
      this.costs(range),
    ]);
    const by = (rows: Record<string, unknown>[], ch: string): Record<string, unknown> =>
      rows.find((r) => r.channel === ch) ?? {};
    const channels = new Set([...rates, ...engagement].map((r) => String(r.channel)));
    return [...channels].map((ch) => ({
      ...by(rates, ch),
      ...by(engagement, ch),
      latencyMs: (by(latency, ch) as { deliveryLatencyMs?: unknown }).deliveryLatencyMs ?? null,
      costPerDeliveredMicros:
        (by(costs, ch) as { costPerDeliveredMicros?: unknown }).costPerDeliveredMicros ?? null,
      channel: ch,
    }));
  }

  /** Daily opt-outs by channel and category over the last `days`, with the rolling rate. */
  async optOutTrends(now: Date, days = 30): Promise<Record<string, unknown>> {
    const since = new Date(now.getTime() - days * 86400000);
    const daily = (await this.db('opt_out_events')
      .where('created_at', '>=', since)
      .groupByRaw(`date_trunc('day', created_at), channel, category`)
      .select(
        this.db.raw(`to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day`),
        'channel',
        'category',
        this.db.raw('count(DISTINCT user_id)::int AS users'),
      )
      .orderBy('day')) as Record<string, unknown>[];
    return {
      windowDays: days,
      daily,
      current: await this.optOuts(now),
      target: { optOutRate: 0.08 },
    };
  }

  /** A/B comparison: delivery, read and click rates per template version. */
  async templateVariants(range: TimeRange, eventType?: string): Promise<Record<string, unknown>[]> {
    const q = this.db('notifications')
      .where('created_at', '>=', range.from)
      .andWhere('created_at', '<', range.to)
      .whereNotNull('template_version')
      .groupBy('event_type', 'channel', 'template_version')
      .select(
        'event_type',
        'channel',
        'template_version',
        this.db.raw('count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent'),
        this.db.raw('count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered'),
        this.db.raw('count(*) FILTER (WHERE read_at IS NOT NULL)::int AS read'),
        this.db.raw('count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked'),
      )
      .orderBy(['event_type', 'channel', 'template_version']);
    if (eventType) q.where('event_type', eventType);
    const rows = (await q) as {
      event_type: string;
      channel: string;
      template_version: number;
      sent: number;
      delivered: number;
      read: number;
      clicked: number;
    }[];
    return rows.map((r) => ({
      eventType: r.event_type,
      channel: r.channel,
      templateVersion: r.template_version,
      sent: r.sent,
      delivered: r.delivered,
      deliveryRate: ratio(r.delivered, r.sent),
      readRate: ratio(r.read, r.delivered),
      clickThroughRate: ratio(r.clicked, r.delivered),
    }));
  }

  /** Which preferences users change most (PDF Day 5), from the audit log and opt-outs. */
  async preferenceChanges(range: TimeRange): Promise<Record<string, unknown>> {
    const [byAction, disabledChannels] = await Promise.all([
      this.db('audit_logs')
        .where('created_at', '>=', range.from)
        .andWhere('created_at', '<', range.to)
        .where('action', 'like', 'PREFERENCES_%')
        .groupBy('action')
        .select('action', this.db.raw('count(*)::int AS changes'))
        .orderBy('changes', 'desc') as Promise<Record<string, unknown>[]>,
      this.db('opt_out_events')
        .where('created_at', '>=', range.from)
        .andWhere('created_at', '<', range.to)
        .where('source', 'PREFERENCE')
        .groupBy('channel')
        .select('channel', this.db.raw('count(*)::int AS disabled'))
        .orderBy('disabled', 'desc') as Promise<Record<string, unknown>[]>,
    ]);
    return { byAction, disabledChannels };
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
