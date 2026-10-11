import type { Redis } from 'ioredis';
import { loadPolicy } from '../../src/config/policy';
import { createRedis } from '../../src/infrastructure/redis/redis';
import { RedisFrequencyCapper } from '../../src/modules/frequency/frequency-capper';
import { RedisRateLimiter } from '../../src/common/rate-limiter';
import { RedisCircuitStore } from '../../src/modules/delivery/redis-circuit-store';
import { CircuitBreaker, InMemoryCircuitStore } from '../../src/modules/delivery/circuit-breaker';
import { RedisDndCache } from '../../src/modules/compliance/redis-dnd-cache';
import { RedisMockBehaviorStore } from '../../src/infrastructure/providers/mock';
import { capperContract } from '../helpers/capper-contract';
import { testConfig } from '../helpers/env';

const policy = loadPolicy();
let redis: Redis;
const prefix = `itest:${Date.now()}:`;

beforeAll(() => {
  redis = createRedis(testConfig().REDIS_URL, 'redis-itest');
});
afterAll(async () => {
  const keys = await redis.keys(`*${prefix}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});

describe('RedisFrequencyCapper (Lua, atomic)', () => {
  capperContract(() => new RedisFrequencyCapper(redis, policy.frequencyCaps, `${prefix}fc:`));

  it('edge 9: admits exactly the limit under 50 concurrent requests', async () => {
    const capper = new RedisFrequencyCapper(redis, policy.frequencyCaps, `${prefix}fc:`);
    const userId = `concurrent-${Date.now()}`;
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        capper.checkAndConsume({
          userId,
          eventRef: `e${i}`,
          category: (['MARKET', 'SIP', 'RISK', 'REGULATORY', 'TRANSACTION'] as const)[i % 5]!,
          cooldownSubject: `s${i}`,
          channels: ['sms'],
          exempt: false,
          now,
        }),
      ),
    );
    const admitted = results.filter((r) => r.allowedChannels.includes('sms')).length;
    expect(admitted).toBe(5); // SMS limit
    expect((await capper.usage(userId, now)).sms).toBe(5);
  });

  it('sets expiries on every counter key (idle keys reset automatically)', async () => {
    const capper = new RedisFrequencyCapper(redis, policy.frequencyCaps, `${prefix}fc:`);
    const userId = `ttl-${Date.now()}`;
    await capper.checkAndConsume({
      userId,
      eventRef: 'e1',
      category: 'SIP',
      cooldownSubject: 'SIPX-001',
      channels: ['email'],
      exempt: false,
      now: new Date(),
    });
    const keys = await redis.keys(`${prefix}fc:{${userId}}:*`);
    expect(keys.length).toBe(4);
    for (const k of keys) expect(await redis.pttl(k)).toBeGreaterThan(0);
  });
});

describe('RedisRateLimiter (sliding window)', () => {
  it('allows up to the limit and rejects with retry-after', async () => {
    const rl = new RedisRateLimiter(redis, `${prefix}rl:`);
    const t = 1_000_000_000_000;
    for (let i = 0; i < 10; i++)
      expect((await rl.consume('k1', 10, 60000, t + i)).allowed).toBe(true);
    const r = await rl.consume('k1', 10, 60000, t + 20);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
    expect(r.remaining).toBe(0);
  });

  it('weights the previous window so bursts at a boundary are still limited', async () => {
    const rl = new RedisRateLimiter(redis, `${prefix}rl:`);
    const w = 60000;
    const start = Math.floor(2_000_000_000_000 / w) * w;
    for (let i = 0; i < 10; i++) await rl.consume('k2', 10, w, start + w - 100 + i);
    // just after the boundary ~100% of the previous window still counts
    expect((await rl.consume('k2', 10, w, start + w + 1)).allowed).toBe(false);
    // halfway through the next window half of it counts
    expect((await rl.consume('k2', 10, w, start + w + w / 2)).allowed).toBe(true);
  });

  it('peek does not consume', async () => {
    const rl = new RedisRateLimiter(redis, `${prefix}rl:`);
    for (let i = 0; i < 5; i++) await rl.peek('k3', 1, 60000);
    expect((await rl.consume('k3', 1, 60000)).allowed).toBe(true);
  });
});

describe('RedisCircuitStore matches the reference reducer', () => {
  const cfg = { failureThreshold: 3, openDurationMs: 1000, halfOpenMaxTrials: 1 };
  it('follows the same transitions as the in-memory model for a scripted sequence', async () => {
    let now = 10_000;
    const redisCb = new CircuitBreaker(
      new RedisCircuitStore(redis, `${prefix}cb:`),
      cfg,
      () => now,
    );
    const memCb = new CircuitBreaker(new InMemoryCircuitStore(), cfg, () => now);
    const script: ['acquire' | 'fail' | 'ok' | 'tick', number?][] = [
      ['acquire'],
      ['fail'],
      ['fail'],
      ['acquire'],
      ['fail'],
      ['acquire'],
      ['tick', 500],
      ['acquire'],
      ['tick', 600],
      ['acquire'],
      ['acquire'],
      ['fail'],
      ['acquire'],
      ['tick', 1000],
      ['acquire'],
      ['ok'],
      ['acquire'],
    ];
    const trace = async (cb: CircuitBreaker) => {
      const out: string[] = [];
      for (const [op, arg] of script) {
        if (op === 'acquire') out.push(String(await cb.acquire('p')));
        if (op === 'fail') out.push(await cb.recordFailure('p'));
        if (op === 'ok') out.push(await cb.recordSuccess('p'));
        if (op === 'tick') now += arg ?? 0;
        out.push((await cb.state('p')).status);
      }
      return out;
    };
    const start = now;
    const a = await trace(redisCb);
    now = start;
    const b = await trace(memCb);
    expect(a).toEqual(b);
    expect(a).toContain('OPEN');
    expect(a).toContain('HALF_OPEN');
  });
});

describe('Redis DND cache and mock behaviour store', () => {
  it('round-trips lookups and invalidates', async () => {
    const cache = new RedisDndCache(redis, `${prefix}dnd:`);
    await cache.set(
      'h1',
      {
        status: 'FULLY_BLOCKED',
        blockedCategories: [],
        registryUpdatedAt: new Date('2026-01-01T00:00:00Z'),
        source: 's',
        stale: false,
        cached: false,
      },
      60,
    );
    const hit = await cache.get('h1');
    expect(hit).toMatchObject({ status: 'FULLY_BLOCKED', cached: true });
    expect(hit?.registryUpdatedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    await cache.invalidateAll();
    expect(await cache.get('h1')).toBeNull();
  });

  it('applies a failure mode for N sends then recovers', async () => {
    const store = new RedisMockBehaviorStore(redis, `${prefix}mock:`);
    await store.set('p', { mode: 'fail_transient', remaining: 2 });
    expect(await store.consume('p')).toBe('fail_transient');
    expect(await store.consume('p')).toBe('fail_transient');
    expect(await store.consume('p')).toBe('ok');
    await store.set('q', { mode: 'timeout', remaining: null });
    expect(await store.consume('q')).toBe('timeout');
    expect(await store.get('q')).toEqual({ mode: 'timeout', remaining: null });
    await store.set('q', { mode: 'ok', remaining: null });
    expect(await store.consume('q')).toBe('ok');
  });
});
