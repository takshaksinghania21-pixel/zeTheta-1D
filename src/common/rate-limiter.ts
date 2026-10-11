import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetMs: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number, now?: number): Promise<RateLimitResult>;
  peek(key: string, limit: number, windowMs: number, now?: number): Promise<RateLimitResult>;
}

/**
 * Sliding-window counter (two fixed buckets, weighted). O(1) memory per key,
 * accurate to within one bucket boundary, evaluated atomically in Lua.
 */
const SCRIPT = `
local now = tonumber(ARGV[1]); local window = tonumber(ARGV[2]); local limit = tonumber(ARGV[3]); local commit = ARGV[4] == '1'
local current = math.floor(now / window)
local curKey = KEYS[1] .. ':' .. current
local prevKey = KEYS[1] .. ':' .. (current - 1)
local cur = tonumber(redis.call('GET', curKey) or '0')
local prev = tonumber(redis.call('GET', prevKey) or '0')
local elapsed = (now % window) / window
local estimate = prev * (1 - elapsed) + cur
if estimate + 1 > limit then
  return {0, math.floor(estimate), window - (now % window)}
end
if commit then
  redis.call('INCR', curKey)
  redis.call('PEXPIRE', curKey, window * 2)
end
return {1, math.floor(estimate) + (commit and 1 or 0), window - (now % window)}
`;

function toResult(raw: [number, number, number], limit: number): RateLimitResult {
  const [allowed, used, resetMs] = raw;
  return {
    allowed: allowed === 1,
    limit,
    remaining: Math.max(0, limit - used),
    resetMs,
    retryAfterMs: allowed === 1 ? 0 : resetMs,
  };
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'rl:',
  ) {}

  async consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): Promise<RateLimitResult> {
    return toResult(
      (await this.redis.eval(SCRIPT, 1, `${this.prefix}${key}`, now, windowMs, limit, '1')) as [
        number,
        number,
        number,
      ],
      limit,
    );
  }

  async peek(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): Promise<RateLimitResult> {
    return toResult(
      (await this.redis.eval(SCRIPT, 1, `${this.prefix}${key}`, now, windowMs, limit, '0')) as [
        number,
        number,
        number,
      ],
      limit,
    );
  }
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, number>();
  private run(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
    commit: boolean,
  ): RateLimitResult {
    const current = Math.floor(now / windowMs);
    const cur = this.counts.get(`${key}:${current}`) ?? 0;
    const prev = this.counts.get(`${key}:${current - 1}`) ?? 0;
    const estimate = prev * (1 - (now % windowMs) / windowMs) + cur;
    const resetMs = windowMs - (now % windowMs);
    if (estimate + 1 > limit) return toResult([0, Math.floor(estimate), resetMs], limit);
    if (commit) this.counts.set(`${key}:${current}`, cur + 1);
    return toResult([1, Math.floor(estimate) + (commit ? 1 : 0), resetMs], limit);
  }
  consume(
    key: string,
    limit: number,
    windowMs: number,
    now = Date.now(),
  ): Promise<RateLimitResult> {
    return Promise.resolve(this.run(key, limit, windowMs, now, true));
  }
  peek(key: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitResult> {
    return Promise.resolve(this.run(key, limit, windowMs, now, false));
  }
}
