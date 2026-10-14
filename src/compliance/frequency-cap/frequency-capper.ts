import type { Redis } from 'ioredis';
import type { NotificationPolicy } from '../../config/policy';
import type { Category, Channel } from '../../utils/types';

export type CapScope = 'GLOBAL' | 'CHANNEL' | 'CATEGORY' | 'COOLDOWN';

export interface CapRequest {
  userId: string;
  /** Unique member id for this logical notification (event id). */
  eventRef: string;
  category: Category;
  /** Cooldown subject (event type, optionally scoped by key fields). */
  cooldownSubject: string;
  /** Intrusive channels to be delivered now (in-app is never counted). */
  channels: Channel[];
  /** Exempt events are counted but never blocked. */
  exempt: boolean;
  /** Per-event cooldown override (seconds); defaults to the policy value. */
  cooldownSeconds?: number;
  now: Date;
  /** Evaluate only; do not consume budget (policy dry-runs). */
  dryRun?: boolean;
}

export interface CapResult {
  allowedChannels: Channel[];
  blocked: { channel: Channel; scope: CapScope }[];
}

export interface FrequencyCapper {
  checkAndConsume(req: CapRequest): Promise<CapResult>;
  /** Records a notified event; returns how many the user received in the digest-suggestion window. */
  recordNotified(userId: string, eventRef: string, now: Date): Promise<number>;
  /** Current counts for diagnostics/API. */
  usage(userId: string, now: Date): Promise<Record<string, number>>;
}

/**
 * Key layout (Redis Cluster safe: the {userId} hash tag pins a user's keys to one slot)
 *   <prefix>{<userId>}:g              ZSET global rolling window   (member = eventRef)
 *   <prefix>{<userId>}:cat:<CATEGORY> ZSET per-category window
 *   <prefix>{<userId>}:ch:<channel>   ZSET per-channel window      (member = eventRef)
 *   <prefix>{<userId>}:cd:<subject>   STRING last-sent ms, PX = cooldown (self-expiring)
 *   <prefix>{<userId>}:notified       ZSET notified events for digest suggestions
 * Every ZSET is trimmed to its window on access and given a PEXPIRE equal to the
 * window, so idle users' keys expire automatically (explicit reset behaviour).
 */
const CAP_SCRIPT = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local exempt = ARGV[3] == '1'
local gLimit = tonumber(ARGV[4]); local gWin = tonumber(ARGV[5])
local cLimit = tonumber(ARGV[6]); local cWin = tonumber(ARGV[7])
local cooldown = tonumber(ARGV[8])
local nch = tonumber(ARGV[9])
local commit = ARGV[10] == '1'
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - gWin)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - cWin)
local result = {''}
-- Idempotent replay: if this event was already admitted (e.g. the consumer
-- crashed before committing and the message was redelivered), return the
-- original per-channel outcome without consuming budget again.
if redis.call('ZSCORE', KEYS[1], member) then
  for i = 1, nch do
    if redis.call('ZSCORE', KEYS[3 + i], member) then result[i + 1] = 1 else result[i + 1] = 0 end
  end
  return result
end
if not exempt then
  local last = redis.call('GET', KEYS[3])
  if cooldown > 0 and last and (now - tonumber(last)) < cooldown then
    result[1] = 'COOLDOWN'
  elseif redis.call('ZCARD', KEYS[1]) >= gLimit then
    result[1] = 'GLOBAL'
  elseif redis.call('ZCARD', KEYS[2]) >= cLimit then
    result[1] = 'CATEGORY'
  end
end
if result[1] ~= '' then
  for i = 1, nch do result[i + 1] = 0 end
  return result
end
local any = false
for i = 1, nch do
  local key = KEYS[3 + i]
  local lim = tonumber(ARGV[9 + 2 * i]); local win = tonumber(ARGV[10 + 2 * i])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - win)
  if exempt or redis.call('ZCARD', key) < lim then result[i + 1] = 1; any = true else result[i + 1] = 0 end
end
if not any then
  result[1] = 'CHANNEL'
  return result
end
if not commit then return result end
redis.call('ZADD', KEYS[1], now, member); redis.call('PEXPIRE', KEYS[1], gWin)
redis.call('ZADD', KEYS[2], now, member); redis.call('PEXPIRE', KEYS[2], cWin)
if cooldown > 0 then redis.call('SET', KEYS[3], now, 'PX', cooldown) end
for i = 1, nch do
  if result[i + 1] == 1 then
    local win = tonumber(ARGV[10 + 2 * i])
    redis.call('ZADD', KEYS[3 + i], now, member); redis.call('PEXPIRE', KEYS[3 + i], win)
  end
end
return result
`;

const HIT_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[3]))
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return redis.call('ZCARD', KEYS[1])
`;

type CapsConfig = NotificationPolicy['frequencyCaps'];

function cappedChannels(cfg: CapsConfig, channels: Channel[]): Channel[] {
  return channels.filter((c) => cfg.countedChannels.includes(c) && cfg.channels[c] !== undefined);
}

/** Window for a counted channel (only called for channels returned by cappedChannels). */
function windowFor(cfg: CapsConfig, c: Channel): { limit: number; windowSeconds: number } {
  const w = cfg.channels[c];
  if (!w) throw new Error(`no frequency cap configured for ${c}`);
  return w;
}

export class RedisFrequencyCapper implements FrequencyCapper {
  constructor(
    private readonly redis: Redis,
    private readonly cfg: CapsConfig,
    private readonly prefix = 'fc:',
  ) {}

  private key(userId: string, suffix: string): string {
    return `${this.prefix}{${userId}}:${suffix}`;
  }

  async checkAndConsume(req: CapRequest): Promise<CapResult> {
    const channels = cappedChannels(this.cfg, req.channels);
    const uncounted = req.channels.filter((c) => !channels.includes(c));
    if (channels.length === 0 || (req.exempt && !this.cfg.countExemptEvents)) {
      return { allowedChannels: [...req.channels], blocked: [] };
    }
    const keys = [
      this.key(req.userId, 'g'),
      this.key(req.userId, `cat:${req.category}`),
      this.key(req.userId, `cd:${req.cooldownSubject}`),
      ...channels.map((c) => this.key(req.userId, `ch:${c}`)),
    ];
    const args: (string | number)[] = [
      req.now.getTime(),
      req.eventRef,
      req.exempt ? '1' : '0',
      this.cfg.global.limit,
      this.cfg.global.windowSeconds * 1000,
      this.cfg.category.limit,
      this.cfg.category.windowSeconds * 1000,
      (req.cooldownSeconds ?? this.cfg.sameEventCooldownSeconds) * 1000,
      channels.length,
      req.dryRun ? '0' : '1',
    ];
    for (const c of channels) {
      const w = windowFor(this.cfg, c);
      args.push(w.limit, w.windowSeconds * 1000);
    }
    const raw = (await this.redis.eval(CAP_SCRIPT, keys.length, ...keys, ...args)) as [
      string,
      ...number[],
    ];
    return interpret(raw, channels, uncounted);
  }

  async recordNotified(userId: string, eventRef: string, now: Date): Promise<number> {
    const n = await this.redis.eval(
      HIT_SCRIPT,
      1,
      this.key(userId, 'notified'),
      now.getTime(),
      eventRef,
      this.cfg.digestSuggestion.windowSeconds * 1000,
    );
    return Number(n);
  }

  async usage(userId: string, now: Date): Promise<Record<string, number>> {
    const t = now.getTime();
    const pipeline = this.redis.pipeline();
    pipeline.zcount(this.key(userId, 'g'), t - this.cfg.global.windowSeconds * 1000, '+inf');
    const chans = Object.keys(this.cfg.channels) as Channel[];
    for (const c of chans)
      pipeline.zcount(
        this.key(userId, `ch:${c}`),
        t - windowFor(this.cfg, c).windowSeconds * 1000,
        '+inf',
      );
    const res = (await pipeline.exec()) ?? [];
    const out: Record<string, number> = { global: Number(res[0]?.[1] ?? 0) };
    chans.forEach((c, i) => (out[c] = Number(res[i + 1]?.[1] ?? 0)));
    return out;
  }
}

function interpret(
  raw: [string, ...number[]],
  channels: Channel[],
  uncounted: Channel[],
): CapResult {
  const [eventBlock, ...flags] = raw;
  const allowed: Channel[] = [...uncounted];
  const blocked: CapResult['blocked'] = [];
  channels.forEach((c, i) => {
    if (eventBlock === '' && Number(flags[i]) === 1) allowed.push(c);
    else
      blocked.push({ channel: c, scope: (eventBlock === '' ? 'CHANNEL' : eventBlock) as CapScope });
  });
  return { allowedChannels: allowed, blocked };
}

/**
 * Single-process implementation with identical semantics, used by unit tests
 * and as the reference model for the Lua script (contract-tested against Redis).
 */
export class InMemoryFrequencyCapper implements FrequencyCapper {
  private readonly zsets = new Map<string, Map<string, number>>();
  private readonly cooldowns = new Map<string, { at: number; expires: number }>();
  constructor(private readonly cfg: CapsConfig) {}

  private trim(key: string, now: number, windowMs: number): Map<string, number> {
    const z = this.zsets.get(key) ?? new Map<string, number>();
    for (const [m, score] of z) if (score <= now - windowMs) z.delete(m);
    this.zsets.set(key, z);
    return z;
  }

  checkAndConsume(req: CapRequest): Promise<CapResult> {
    const channels = cappedChannels(this.cfg, req.channels);
    const uncounted = req.channels.filter((c) => !channels.includes(c));
    if (channels.length === 0 || (req.exempt && !this.cfg.countExemptEvents)) {
      return Promise.resolve({ allowedChannels: [...req.channels], blocked: [] });
    }
    const now = req.now.getTime();
    const g = this.trim(`${req.userId}:g`, now, this.cfg.global.windowSeconds * 1000);
    const cat = this.trim(
      `${req.userId}:cat:${req.category}`,
      now,
      this.cfg.category.windowSeconds * 1000,
    );
    if (g.has(req.eventRef)) {
      const replay = channels.map((c) =>
        this.zsets.get(`${req.userId}:ch:${c}`)?.has(req.eventRef) ? 1 : 0,
      );
      return Promise.resolve(interpret(['', ...replay], channels, uncounted));
    }
    const cdKey = `${req.userId}:cd:${req.cooldownSubject}`;
    const cd = this.cooldowns.get(cdKey);
    const cooldownMs = (req.cooldownSeconds ?? this.cfg.sameEventCooldownSeconds) * 1000;
    let eventBlock = '';
    if (!req.exempt) {
      if (cooldownMs > 0 && cd && cd.expires > now && now - cd.at < cooldownMs)
        eventBlock = 'COOLDOWN';
      else if (g.size >= this.cfg.global.limit) eventBlock = 'GLOBAL';
      else if (cat.size >= this.cfg.category.limit) eventBlock = 'CATEGORY';
    }
    const flags: number[] = [];
    if (eventBlock === '') {
      for (const c of channels) {
        const w = windowFor(this.cfg, c);
        const z = this.trim(`${req.userId}:ch:${c}`, now, w.windowSeconds * 1000);
        flags.push(req.exempt || z.size < w.limit ? 1 : 0);
      }
      if (!flags.includes(1)) eventBlock = 'CHANNEL';
    }
    if (eventBlock === '' && !req.dryRun) {
      g.set(req.eventRef, now);
      cat.set(req.eventRef, now);
      if (cooldownMs > 0) this.cooldowns.set(cdKey, { at: now, expires: now + cooldownMs });
      channels.forEach((c, i) => {
        if (flags[i] === 1) this.zsets.get(`${req.userId}:ch:${c}`)?.set(req.eventRef, now);
      });
    }
    return Promise.resolve(
      interpret([eventBlock, ...channels.map((_, i) => flags[i] ?? 0)], channels, uncounted),
    );
  }

  recordNotified(userId: string, eventRef: string, now: Date): Promise<number> {
    const z = this.trim(
      `${userId}:notified`,
      now.getTime(),
      this.cfg.digestSuggestion.windowSeconds * 1000,
    );
    z.set(eventRef, now.getTime());
    return Promise.resolve(z.size);
  }

  usage(userId: string, now: Date): Promise<Record<string, number>> {
    const t = now.getTime();
    const out: Record<string, number> = {
      global: this.trim(`${userId}:g`, t, this.cfg.global.windowSeconds * 1000).size,
    };
    for (const c of Object.keys(this.cfg.channels) as Channel[]) {
      out[c] = this.trim(`${userId}:ch:${c}`, t, windowFor(this.cfg, c).windowSeconds * 1000).size;
    }
    return Promise.resolve(out);
  }
}
