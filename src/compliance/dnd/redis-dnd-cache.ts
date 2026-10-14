import type { Redis } from 'ioredis';
import type { DndCache, DndLookupResult } from './dnd';

/** Redis cache for DND lookups (keys hold only blind-index hashes, no phone numbers). */
export class RedisDndCache implements DndCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'dnd:',
  ) {}

  async get(phoneHash: string): Promise<DndLookupResult | null> {
    const raw = await this.redis.get(`${this.prefix}${phoneHash}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as Omit<DndLookupResult, 'registryUpdatedAt'> & {
      registryUpdatedAt: string | null;
    };
    return {
      ...v,
      registryUpdatedAt: v.registryUpdatedAt ? new Date(v.registryUpdatedAt) : null,
      cached: true,
    };
  }

  async set(phoneHash: string, value: DndLookupResult, ttlSeconds: number): Promise<void> {
    await this.redis.set(`${this.prefix}${phoneHash}`, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /** Called after a registry import so new data takes effect immediately. */
  async invalidateAll(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.prefix}*`, 'COUNT', 500);
      if (keys.length > 0) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  }
}
