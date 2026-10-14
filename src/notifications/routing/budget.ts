import type { Redis } from 'ioredis';
import type { Channel } from '../../utils/types';

/**
 * Spend tracking in micro-INR (UTC buckets): per channel per day (operator budget)
 * and per user per day/month (PDF §A3.2 Priority 4: "cost budgets per user per day/month").
 */
export interface BudgetTracker {
  spent(channel: Channel, now: Date): Promise<number>;
  userSpent(userId: string, now: Date): Promise<{ day: number; month: number }>;
  add(channel: Channel, micros: number, now: Date, userId?: string): Promise<void>;
}

const day = (now: Date): string => now.toISOString().slice(0, 10);
const month = (now: Date): string => now.toISOString().slice(0, 7);

export class RedisBudgetTracker implements BudgetTracker {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'budget:',
  ) {}
  async spent(channel: Channel, now: Date): Promise<number> {
    return Number((await this.redis.get(`${this.prefix}${channel}:${day(now)}`)) ?? 0);
  }
  async userSpent(userId: string, now: Date): Promise<{ day: number; month: number }> {
    const [d, m] = await this.redis.mget(
      `${this.prefix}u:${userId}:${day(now)}`,
      `${this.prefix}u:${userId}:${month(now)}`,
    );
    return { day: Number(d ?? 0), month: Number(m ?? 0) };
  }
  async add(channel: Channel, micros: number, now: Date, userId?: string): Promise<void> {
    if (micros <= 0) return;
    const tx = this.redis.multi();
    const keys: [string, number][] = [[`${this.prefix}${channel}:${day(now)}`, 3 * 86400]];
    if (userId)
      keys.push(
        [`${this.prefix}u:${userId}:${day(now)}`, 2 * 86400],
        [`${this.prefix}u:${userId}:${month(now)}`, 32 * 86400],
      );
    for (const [key, ttl] of keys) tx.incrby(key, micros).expire(key, ttl);
    await tx.exec();
  }
}

export class InMemoryBudgetTracker implements BudgetTracker {
  private readonly map = new Map<string, number>();
  private get(k: string): number {
    return this.map.get(k) ?? 0;
  }
  spent(channel: Channel, now: Date): Promise<number> {
    return Promise.resolve(this.get(`${channel}:${day(now)}`));
  }
  userSpent(userId: string, now: Date): Promise<{ day: number; month: number }> {
    return Promise.resolve({
      day: this.get(`u:${userId}:${day(now)}`),
      month: this.get(`u:${userId}:${month(now)}`),
    });
  }
  add(channel: Channel, micros: number, now: Date, userId?: string): Promise<void> {
    const keys = [`${channel}:${day(now)}`];
    if (userId) keys.push(`u:${userId}:${day(now)}`, `u:${userId}:${month(now)}`);
    for (const k of keys) this.map.set(k, this.get(k) + micros);
    return Promise.resolve();
  }
}
