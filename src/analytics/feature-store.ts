import type { Redis } from 'ioredis';
import type { LifecycleEvent } from '../database/models/notification';
import type { Channel } from '../utils/types';

export type ChannelEngagement = Partial<Record<Channel, { delivered: number; engaged: number }>>;

/** Lifecycle states counted in real time (PDF Day 10: delivery/failure counts, latency). */
const COUNTED: Partial<Record<LifecycleEvent['to'], string>> = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  CLICKED: 'clicked',
  FAILED: 'failed',
  BOUNCED: 'failed',
  DLQ: 'dlq',
  CAPPED: 'capped',
  DND: 'dnd',
};
const MINUTE = 60000;
const REALTIME_TTL_SECONDS = 2 * 3600;
const ENGAGEMENT_TTL_SECONDS = 90 * 86400;

/**
 * Redis feature store (PDF §C5.3 pattern, Day 10 real-time counters):
 *  - `rt:<minute>` HASH `<channel>:<metric>` — per-minute counts, latency sum and cost,
 *    kept 2 h; summed for sub-30-second-lag dashboards.
 *  - `eng:<userId>` HASH `<channel>:delivered|engaged` — per-user, per-channel engagement
 *    (read or click) used by routing priority 3 (§A3.2), kept 90 days.
 * Fed by the analytics consumer, which records each lifecycle transition once.
 */
export class FeatureStore {
  constructor(private readonly redis: Redis) {}

  async record(e: LifecycleEvent): Promise<void> {
    const metric = COUNTED[e.to];
    if (!metric) return;
    const at = Date.parse(e.at);
    const rt = `rt:${Math.floor(at / MINUTE)}`;
    const tx = this.redis.multi().hincrby(rt, `${e.channel}:${metric}`, 1);
    if (e.to === 'DELIVERED')
      tx.hincrby(rt, `${e.channel}:latency_ms`, Math.round(e.sinceCreatedMs));
    if (e.to === 'SENT' && e.costMicros) tx.hincrby(rt, `${e.channel}:cost_micros`, e.costMicros);
    tx.expire(rt, REALTIME_TTL_SECONDS);
    if (e.to === 'DELIVERED' || e.to === 'READ' || e.to === 'CLICKED') {
      const eng = `eng:${e.userId}`;
      // READ/CLICKED both count as engagement; a READ also implies delivery.
      if (e.to !== 'CLICKED' && e.from !== 'DELIVERED')
        tx.hincrby(eng, `${e.channel}:delivered`, 1);
      if (e.to !== 'DELIVERED') tx.hincrby(eng, `${e.channel}:engaged`, 1);
      tx.expire(eng, ENGAGEMENT_TTL_SECONDS);
    }
    await tx.exec();
  }

  /** Per-channel totals over the last `minutes` (inclusive of the current minute). */
  async realtime(now: Date, minutes = 5): Promise<Record<string, Record<string, number>>> {
    const current = Math.floor(now.getTime() / MINUTE);
    const pipeline = this.redis.pipeline();
    for (let m = current - minutes + 1; m <= current; m++) pipeline.hgetall(`rt:${m}`);
    const out: Record<string, Record<string, number>> = {};
    for (const [, hash] of (await pipeline.exec()) ?? []) {
      for (const [field, value] of Object.entries((hash ?? {}) as Record<string, string>)) {
        const [channel, metric] = field.split(':') as [string, string];
        const c = (out[channel] ??= {});
        c[metric] = (c[metric] ?? 0) + Number(value);
      }
    }
    for (const c of Object.values(out))
      if (c.delivered) c.avgDeliveryLatencyMs = Math.round((c.latency_ms ?? 0) / c.delivered);
    return out;
  }

  async engagement(userId: string): Promise<ChannelEngagement> {
    const hash = await this.redis.hgetall(`eng:${userId}`);
    const out: ChannelEngagement = {};
    for (const [field, value] of Object.entries(hash)) {
      const [channel, kind] = field.split(':') as [Channel, 'delivered' | 'engaged'];
      const c = (out[channel] ??= { delivered: 0, engaged: 0 });
      c[kind] = Number(value);
    }
    return out;
  }
}
