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
local s = redis.call('HMGET', KEYS[1], 'status', 'failures', 'openedAt', 'inflight', 'windowStartedAt')
local status = s[1] or 'CLOSED'
local failures = tonumber(s[2] or '0') or 0
local openedAt = tonumber(s[3] or '')
local inflight = tonumber(s[4] or '0') or 0
local windowStartedAt = tonumber(s[5] or '')
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
local now = tonumber(ARGV[1]); local threshold = tonumber(ARGV[2]); local windowMs = tonumber(ARGV[3])
if status == 'CLOSED' then
  if (not windowStartedAt) or now - windowStartedAt >= windowMs then
    failures = 1; windowStartedAt = now
  else
    failures = failures + 1
  end
else
  failures = failures + 1
end
if status ~= 'CLOSED' or failures >= threshold then
  redis.call('HDEL', KEYS[1], 'windowStartedAt')
  redis.call('HSET', KEYS[1], 'status', 'OPEN', 'failures', failures, 'openedAt', now, 'inflight', 0)
  redis.call('EXPIRE', KEYS[1], 86400)
  return 'OPEN'
end
redis.call('HSET', KEYS[1], 'status', status, 'failures', failures, 'windowStartedAt', windowStartedAt)
redis.call('EXPIRE', KEYS[1], 86400)
return status
`;

const SUCCESS = `${READ}
if status ~= 'CLOSED' then redis.call('DEL', KEYS[1]) end
return 'CLOSED'
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
      failures: Number(h.failures ?? 0),
      windowStartedAt: h.windowStartedAt ? Number(h.windowStartedAt) : null,
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
    return (await this.redis.eval(SUCCESS, 1, this.key(provider))) as CircuitStatus;
  }

  async onFailure(provider: string, now: number, cfg: CircuitConfig): Promise<CircuitStatus> {
    return (await this.redis.eval(
      FAILURE,
      1,
      this.key(provider),
      now,
      cfg.failureThreshold,
      cfg.failureWindowMs,
    )) as CircuitStatus;
  }

  async reset(provider: string): Promise<void> {
    await this.redis.del(this.key(provider));
  }
}
