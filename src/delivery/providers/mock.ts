import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Channel } from '../../utils/types';
import type { Logger } from '../../utils/logger';
import { validateRecipientFormat } from '../../database/models/contacts';
import { signGeneric } from '../webhooks/signatures';
import {
  ProviderError,
  type DeliveryProvider,
  type DeliveryRequest,
  type DeliveryResult,
  type ProviderQuota,
  type ProviderStatus,
  type RecipientValidation,
} from './provider';

export const MOCK_MODES = [
  'ok',
  'fail_transient',
  'fail_permanent',
  'timeout',
  'rate_limited',
  'invalid_recipient',
  'auth_error',
] as const;
export type MockMode = (typeof MOCK_MODES)[number];

export interface MockBehavior {
  mode: MockMode;
  /** Number of sends the mode applies to; null = until changed. */
  remaining: number | null;
}

export interface MockBehaviorStore {
  set(provider: string, behavior: MockBehavior): Promise<void>;
  get(provider: string): Promise<MockBehavior>;
  /** Atomically consumes one send and returns the mode that applies to it. */
  consume(provider: string): Promise<MockMode>;
}

export class InMemoryMockBehaviorStore implements MockBehaviorStore {
  private readonly map = new Map<string, MockBehavior>();
  set(provider: string, behavior: MockBehavior): Promise<void> {
    this.map.set(provider, { ...behavior });
    return Promise.resolve();
  }
  get(provider: string): Promise<MockBehavior> {
    return Promise.resolve(this.map.get(provider) ?? { mode: 'ok', remaining: null });
  }
  consume(provider: string): Promise<MockMode> {
    const b = this.map.get(provider);
    if (!b) return Promise.resolve('ok');
    if (b.remaining === null) return Promise.resolve(b.mode);
    if (b.remaining <= 0) {
      this.map.delete(provider);
      return Promise.resolve('ok');
    }
    b.remaining--;
    return Promise.resolve(b.mode);
  }
}

const CONSUME = `
local mode = redis.call('HGET', KEYS[1], 'mode')
if not mode then return 'ok' end
local remaining = redis.call('HGET', KEYS[1], 'remaining')
if remaining == '' or remaining == false then return mode end
local n = tonumber(remaining)
if n <= 0 then redis.call('DEL', KEYS[1]); return 'ok' end
redis.call('HSET', KEYS[1], 'remaining', n - 1)
return mode
`;

/** Shared behaviour store so the API (operator controls) and workers agree. */
export class RedisMockBehaviorStore implements MockBehaviorStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'mock:provider:',
  ) {}
  async set(provider: string, behavior: MockBehavior): Promise<void> {
    const key = `${this.prefix}${provider}`;
    if (behavior.mode === 'ok') {
      await this.redis.del(key);
      return;
    }
    await this.redis.hset(key, {
      mode: behavior.mode,
      remaining: behavior.remaining === null ? '' : String(behavior.remaining),
    });
    await this.redis.expire(key, 86400);
  }
  async get(provider: string): Promise<MockBehavior> {
    const h = await this.redis.hgetall(`${this.prefix}${provider}`);
    if (!h.mode) return { mode: 'ok', remaining: null };
    return {
      mode: h.mode as MockMode,
      remaining: h.remaining === '' || h.remaining === undefined ? null : Number(h.remaining),
    };
  }
  async consume(provider: string): Promise<MockMode> {
    return (await this.redis.eval(CONSUME, 1, `${this.prefix}${provider}`)) as MockMode;
  }
}

export interface MockProviderOptions {
  costMicros: number;
  latencyMs?: number;
  receipts?: { url: string; secret: string; delayMs: number } | undefined;
}

/**
 * Deterministic provider simulator for local development and tests. Failure
 * modes are injected through the behaviour store; successful sends optionally
 * produce signed DELIVERED receipts via the real webhook endpoint.
 */
export class MockProvider implements DeliveryProvider {
  readonly sent: DeliveryRequest[] = [];
  private readonly statuses = new Map<string, ProviderStatus>();

  constructor(
    readonly name: string,
    readonly channel: Channel,
    private readonly behavior: MockBehaviorStore,
    private readonly options: MockProviderOptions,
    private readonly logger?: Logger,
  ) {}

  async send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult> {
    const mode = await this.behavior.consume(this.name);
    if (this.options.latencyMs) await new Promise((r) => setTimeout(r, this.options.latencyMs));
    switch (mode) {
      case 'fail_transient':
        throw new ProviderError('TRANSIENT', 'MOCK_503', 'Simulated provider outage', {
          httpStatus: 503,
        });
      case 'fail_permanent':
        throw new ProviderError('PERMANENT', 'MOCK_400', 'Simulated permanent rejection', {
          httpStatus: 400,
        });
      case 'invalid_recipient':
        throw new ProviderError(
          'INVALID_RECIPIENT',
          'MOCK_UNREGISTERED',
          'Simulated invalid recipient / expired token',
          { httpStatus: 404 },
        );
      case 'rate_limited':
        throw new ProviderError('RATE_LIMITED', 'MOCK_429', 'Simulated provider rate limit', {
          httpStatus: 429,
          retryAfterMs: 1000,
        });
      case 'auth_error':
        throw new ProviderError('AUTH', 'MOCK_401', 'Simulated credential failure', {
          httpStatus: 401,
        });
      case 'timeout':
        await new Promise<void>((_, reject) => {
          if (signal.aborted)
            reject(new ProviderError('TIMEOUT', 'TIMEOUT', 'Provider request timed out'));
          signal.addEventListener(
            'abort',
            () => {
              reject(new ProviderError('TIMEOUT', 'TIMEOUT', 'Provider request timed out'));
            },
            { once: true },
          );
        });
        throw new ProviderError('TIMEOUT', 'TIMEOUT', 'unreachable');
      case 'ok':
        break;
    }
    const id = `${this.name}-${randomUUID()}`;
    if (this.sent.length > 1000) this.sent.shift();
    this.sent.push(req);
    this.statuses.set(id, { providerMessageId: id, status: 'SENT' });
    this.scheduleReceipt(id);
    return { providerMessageId: id, status: 'ACCEPTED', costMicros: this.options.costMicros };
  }

  private scheduleReceipt(id: string): void {
    const r = this.options.receipts;
    if (!r) return;
    setTimeout(() => {
      const body = JSON.stringify({
        provider: this.name,
        events: [
          {
            id: `${id}:DELIVERED`,
            providerMessageId: id,
            status: 'DELIVERED',
            occurredAt: new Date().toISOString(),
          },
        ],
      });
      fetch(r.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-zetheta-signature': signGeneric(r.secret, body, Math.floor(Date.now() / 1000)),
        },
        body,
      })
        .then(() => this.statuses.set(id, { providerMessageId: id, status: 'DELIVERED' }))
        .catch((err: unknown) =>
          this.logger?.warn({ err, provider: this.name }, 'mock receipt callback failed'),
        );
    }, r.delayMs).unref();
  }

  getStatus(providerMessageId: string): Promise<ProviderStatus> {
    return Promise.resolve(
      this.statuses.get(providerMessageId) ?? { providerMessageId, status: 'UNKNOWN' },
    );
  }

  validateRecipient(recipient: string): RecipientValidation {
    return validateRecipientFormat(this.channel, recipient)
      ? { valid: true }
      : { valid: false, reason: `invalid ${this.channel} recipient format` };
  }

  getQuota(): Promise<ProviderQuota> {
    return Promise.resolve({
      limitPerMinute: null,
      remaining: null,
      resetAt: null,
      source: 'unlimited',
    });
  }
}
