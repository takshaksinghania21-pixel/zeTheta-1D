import type { Redis } from 'ioredis';
import {
  INITIAL_CIRCUIT,
  type CircuitConfig,
  type CircuitState,
  type CircuitStatus,
  type CircuitStore,
} from './circuit-breaker';

// Lua mirrors of the pure reducer in circuit-breaker.ts (contract-tested against it).
const READ = `
local s = redis.call('HMGET', KEYS[1], 'status', 'failures', 'openedAt', 'inflight')
local status = s[1] or 'CLOSED'
local failures = tonumber(s[2] or '0') or 0
local openedAt = tonumber(s[3] or '')
local inflight = tonumber(s[4] or '0') or 0
`;

const ACQUIRE = `${READ}
local now = tonumber(ARGV[1]); local openMs = tonumber(ARGV[2]); local maxTrials = tonumber(ARGV[3])
if status == 'CLOSED' then return 1 end
if status == 'OPEN' then
  if openedAt and now - openedAt >= openMs then
    redis.call('HSET', KEYS[1], 'status', 'HALF_OPEN', 'inflight', 1, 'openedAt', now)
    redis.call('EXPIRE', KEYS[1], 86400)
    return 1
  end
  return 0
end
if inflight < maxTrials then
  redis.call('HSET', KEYS[1], 'inflight', inflight + 1)
  return 1
end
if openedAt and now - openedAt >= openMs then
  redis.call('HSET', KEYS[1], 'inflight', 1, 'openedAt', now)
  return 1
end
return 0
`;

const FAILURE = `${READ}
local now = tonumber(ARGV[1]); local threshold = tonumber(ARGV[2])
failures = failures + 1
if status == 'HALF_OPEN' or failures >= threshold then
  redis.call('HSET', KEYS[1], 'status', 'OPEN', 'failures', failures, 'openedAt', now, 'inflight', 0)
  redis.call('EXPIRE', KEYS[1], 86400)
  return 'OPEN'
end
redis.call('HSET', KEYS[1], 'status', status, 'failures', failures)
redis.call('EXPIRE', KEYS[1], 86400)
return status
`;

/** Shared circuit state so every dispatcher instance and the router agree on provider health. */
export class RedisCircuitStore implements CircuitStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'cb:',
  ) {}

  private key(p: string): string {
    return `${this.prefix}${p}`;
  }

  async get(provider: string): Promise<CircuitState> {
    const h = await this.redis.hgetall(this.key(provider));
    if (!h.status) return { ...INITIAL_CIRCUIT };
    return {
      status: h.status as CircuitStatus,
      consecutiveFailures: Number(h.failures ?? 0),
      openedAt: h.openedAt ? Number(h.openedAt) : null,
      halfOpenInFlight: Number(h.inflight ?? 0),
    };
  }

  async acquire(provider: string, now: number, cfg: CircuitConfig): Promise<boolean> {
    return (
      (await this.redis.eval(
        ACQUIRE,
        1,
        this.key(provider),
        now,
        cfg.openDurationMs,
        cfg.halfOpenMaxTrials,
      )) === 1
    );
  }

  async onSuccess(provider: string): Promise<CircuitStatus> {
    await this.redis.del(this.key(provider));
    return 'CLOSED';
  }

  async onFailure(provider: string, now: number, cfg: CircuitConfig): Promise<CircuitStatus> {
    return (await this.redis.eval(
      FAILURE,
      1,
      this.key(provider),
      now,
      cfg.failureThreshold,
    )) as CircuitStatus;
  }

  async reset(provider: string): Promise<void> {
    await this.redis.del(this.key(provider));
  }
}
