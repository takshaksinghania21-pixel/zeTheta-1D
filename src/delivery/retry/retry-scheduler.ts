import type { Redis } from 'ioredis';
import type { Knex } from 'knex';
import type { Logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import type { NotificationFactory } from '../../notifications/engine/factory';
import type { NotificationRow } from '../../database/models/notification';

/** What a scheduled retry needs to be re-enqueued without reading the row again. */
type RetryTarget = Pick<NotificationRow, 'id' | 'channel' | 'priority' | 'correlation_id'> & {
  created_at: Date | string;
};

// Atomically take up to ARGV[2] members due at or before ARGV[1], so concurrent
// schedulers never release the same retry twice.
const POP_DUE = `
local items = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #items > 0 then redis.call('ZREM', KEYS[1], unpack(items)) end
return items`;

/**
 * Retry scheduling with a Redis sorted set (PDF Day 9): member = retry,
 * score = due time (ms). PostgreSQL `next_attempt_at` (state RETRYING) stays the
 * durable record: a member lost to a Redis failure or a crash between pop and
 * enqueue is re-enqueued by the scheduler's stale sweep.
 */
export class RedisRetryScheduler {
  constructor(
    private readonly redis: Redis,
    private readonly db: Knex,
    private readonly factory: NotificationFactory,
    private readonly logger: Logger,
    private readonly key: string,
    /** Max retries released per tick: bounds the burst after an outage (retry-storm guard). */
    private readonly batchSize = 500,
  ) {}

  async schedule(n: RetryTarget, retry: number, dueAt: Date): Promise<void> {
    const member = JSON.stringify({
      id: n.id,
      created_at: new Date(n.created_at).toISOString(),
      channel: n.channel,
      priority: n.priority,
      correlation_id: n.correlation_id,
      retry,
    });
    await this.redis.zadd(this.key, dueAt.getTime(), member);
  }

  /** Moves due retries to the delivery queue (via the outbox); returns how many. */
  async releaseDue(now: Date): Promise<number> {
    const due = (await this.redis.eval(
      POP_DUE,
      1,
      this.key,
      String(now.getTime()),
      String(this.batchSize),
    )) as string[];
    for (const member of due) {
      const { retry, ...row } = JSON.parse(member) as RetryTarget & { retry: number };
      await this.factory.enqueueDelivery(this.db, row, retry);
    }
    metrics.retryQueueDepth.set(await this.redis.zcard(this.key));
    if (due.length === this.batchSize)
      this.logger.warn({ released: due.length }, 'retry release batch full; backlog remains');
    return due.length;
  }

  depth(): Promise<number> {
    return this.redis.zcard(this.key);
  }
}
