import type { Redis } from 'ioredis';
import type { Channel } from '../../domain/types';

/** Daily per-channel spend tracking in micro-INR (UTC day buckets). */
export interface BudgetTracker {
  spent(channel: Channel, now: Date): Promise<number>;
  add(channel: Channel, micros: number, now: Date): Promise<void>;
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class RedisBudgetTracker implements BudgetTracker {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'budget:',
  ) {}
  async spent(channel: Channel, now: Date): Promise<number> {
    return Number((await this.redis.get(`${this.prefix}${channel}:${day(now)}`)) ?? 0);
  }
  async add(channel: Channel, micros: number, now: Date): Promise<void> {
    if (micros <= 0) return;
    const key = `${this.prefix}${channel}:${day(now)}`;
    await this.redis
      .multi()
      .incrby(key, micros)
      .expire(key, 3 * 86400)
      .exec();
  }
}

export class InMemoryBudgetTracker implements BudgetTracker {
  private readonly map = new Map<string, number>();
  spent(channel: Channel, now: Date): Promise<number> {
    return Promise.resolve(this.map.get(`${channel}:${day(now)}`) ?? 0);
  }
  add(channel: Channel, micros: number, now: Date): Promise<void> {
    const k = `${channel}:${day(now)}`;
    this.map.set(k, (this.map.get(k) ?? 0) + micros);
    return Promise.resolve();
  }
}
