import type { Knex } from 'knex';
import type { Emitter } from '@socket.io/redis-emitter';
import type { AppConfig } from '../../config/env';
import type { NotificationPolicy } from '../../config/policy';
import type { Logger } from '../../common/logger';
import { metrics } from '../../common/metrics';
import { CHANNELS, type Channel } from '../../domain/types';
import { FcmPushProvider } from '../../infrastructure/providers/fcm';
import { MockProvider, type MockBehaviorStore } from '../../infrastructure/providers/mock';
import { Msg91SmsProvider } from '../../infrastructure/providers/msg91';
import { SmtpEmailProvider } from '../../infrastructure/providers/smtp';
import { SocketIoInAppProvider } from '../../infrastructure/providers/socketio';
import { TwilioSmsProvider } from '../../infrastructure/providers/twilio';
import { WhatsAppCloudProvider } from '../../infrastructure/providers/whatsapp';
import type { ChannelHealth } from '../routing/routing-engine';
import { circuitGaugeValue, type CircuitBreaker } from './circuit-breaker';
import type { DeliveryProvider } from './provider';

export interface ProviderConfigRow {
  name: string;
  channel: Channel;
  enabled: boolean;
  priority: number;
  cost_micros: number;
  rate_limit_per_minute: number;
  timeout_ms: number;
}

export interface ProviderEntry extends ProviderConfigRow {
  provider: DeliveryProvider;
}

function required<K extends string>(
  name: string,
  values: Record<K, string | undefined>,
): Record<K, string> {
  const out = {} as Record<K, string>;
  const missing: string[] = [];
  for (const k of Object.keys(values) as K[]) {
    const v = values[k];
    if (v) out[k] = v;
    else missing.push(k);
  }
  if (missing.length > 0)
    throw new Error(
      `Provider ${name} is configured but missing credentials: ${missing.join(', ')}`,
    );
  return out;
}

/**
 * Builds provider adapters from configuration. Any explicitly configured real
 * provider without credentials aborts startup (fail-safe), in every mode.
 */
export function buildProviders(
  cfg: AppConfig,
  policy: NotificationPolicy,
  deps: { mockStore: MockBehaviorStore; emitter?: Pick<Emitter, 'to'>; logger?: Logger },
): DeliveryProvider[] {
  const lists: Record<Channel, string[]> = {
    sms: cfg.SMS_PROVIDERS,
    email: cfg.EMAIL_PROVIDERS,
    push: cfg.PUSH_PROVIDERS,
    whatsapp: cfg.WHATSAPP_PROVIDERS,
    inapp: cfg.INAPP_PROVIDERS,
  };
  const out: DeliveryProvider[] = [];
  for (const channel of CHANNELS) {
    const cost = policy.costs.perMessageMicros[channel];
    for (const name of lists[channel]) {
      if (name.startsWith('mock')) {
        const receipts = cfg.MOCK_RECEIPT_CALLBACK_URL
          ? {
              url: cfg.MOCK_RECEIPT_CALLBACK_URL,
              secret: cfg.WEBHOOK_SIGNING_SECRET,
              delayMs: cfg.MOCK_RECEIPT_DELAY_MS,
            }
          : undefined;
        out.push(
          new MockProvider(
            name,
            channel,
            deps.mockStore,
            { costMicros: cost, receipts },
            deps.logger,
          ),
        );
        continue;
      }
      switch (`${channel}:${name}`) {
        case 'sms:twilio': {
          const c = required(name, {
            TWILIO_ACCOUNT_SID: cfg.TWILIO_ACCOUNT_SID,
            TWILIO_AUTH_TOKEN: cfg.TWILIO_AUTH_TOKEN,
            TWILIO_FROM_NUMBER: cfg.TWILIO_FROM_NUMBER,
          });
          out.push(
            new TwilioSmsProvider(name, {
              accountSid: c.TWILIO_ACCOUNT_SID,
              authToken: c.TWILIO_AUTH_TOKEN,
              fromNumber: c.TWILIO_FROM_NUMBER,
              baseUrl: cfg.TWILIO_BASE_URL,
              statusCallbackUrl: `${cfg.PUBLIC_BASE_URL}/api/v1/webhooks/twilio`,
              costMicros: cost,
            }),
          );
          break;
        }
        case 'sms:msg91': {
          const c = required(name, {
            MSG91_AUTH_KEY: cfg.MSG91_AUTH_KEY,
            MSG91_FLOW_ID: cfg.MSG91_FLOW_ID,
          });
          out.push(
            new Msg91SmsProvider(name, {
              authKey: c.MSG91_AUTH_KEY,
              flowId: c.MSG91_FLOW_ID,
              baseUrl: cfg.MSG91_BASE_URL,
              costMicros: cost,
            }),
          );
          break;
        }
        case 'email:smtp':
          out.push(
            new SmtpEmailProvider(name, {
              host: cfg.SMTP_HOST,
              port: cfg.SMTP_PORT,
              secure: cfg.SMTP_SECURE,
              user: cfg.SMTP_USER,
              pass: cfg.SMTP_PASS,
              from: cfg.EMAIL_FROM,
              costMicros: cost,
              timeoutMs: cfg.PROVIDER_TIMEOUT_MS,
            }),
          );
          break;
        case 'push:fcm': {
          const c = required(name, {
            FCM_PROJECT_ID: cfg.FCM_PROJECT_ID,
            FCM_CLIENT_EMAIL: cfg.FCM_CLIENT_EMAIL,
            FCM_PRIVATE_KEY_BASE64: cfg.FCM_PRIVATE_KEY_BASE64,
          });
          out.push(
            new FcmPushProvider(name, {
              projectId: c.FCM_PROJECT_ID,
              clientEmail: c.FCM_CLIENT_EMAIL,
              privateKeyPem: Buffer.from(c.FCM_PRIVATE_KEY_BASE64, 'base64').toString('utf8'),
              baseUrl: cfg.FCM_BASE_URL,
              tokenUrl: cfg.FCM_TOKEN_URL,
              costMicros: cost,
            }),
          );
          break;
        }
        case 'whatsapp:whatsapp-cloud': {
          const c = required(name, {
            WHATSAPP_PHONE_NUMBER_ID: cfg.WHATSAPP_PHONE_NUMBER_ID,
            WHATSAPP_ACCESS_TOKEN: cfg.WHATSAPP_ACCESS_TOKEN,
            WHATSAPP_APP_SECRET: cfg.WHATSAPP_APP_SECRET,
          });
          out.push(
            new WhatsAppCloudProvider(name, {
              phoneNumberId: c.WHATSAPP_PHONE_NUMBER_ID,
              accessToken: c.WHATSAPP_ACCESS_TOKEN,
              apiVersion: cfg.WHATSAPP_API_VERSION,
              baseUrl: cfg.WHATSAPP_BASE_URL,
              costMicros: cost,
            }),
          );
          break;
        }
        case 'inapp:socketio':
          if (!deps.emitter) throw new Error('socketio provider requires a Redis emitter');
          out.push(new SocketIoInAppProvider(name, deps.emitter));
          break;
        default:
          throw new Error(`Unknown provider '${name}' for channel ${channel}`);
      }
    }
  }
  return out;
}

/** Provider lookup ordered by DB-configured priority, honouring enable flags and circuits. */
export class ProviderRegistry implements ChannelHealth {
  private readonly byName: Map<string, DeliveryProvider>;
  private cache: { rows: ProviderConfigRow[]; expires: number } | undefined;

  constructor(
    providers: DeliveryProvider[],
    private readonly db: Knex,
    private readonly circuit: CircuitBreaker,
    private readonly defaults: { timeoutMs: number; costs: Record<Channel, number> },
    private readonly cacheTtlMs = 5000,
  ) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }

  providers(): DeliveryProvider[] {
    return [...this.byName.values()];
  }

  get(name: string): DeliveryProvider | undefined {
    return this.byName.get(name);
  }

  /** Inserts default config rows for configured providers (idempotent). */
  async sync(): Promise<void> {
    const perChannelIndex = new Map<Channel, number>();
    const rows = this.providers().map((p) => {
      const idx = perChannelIndex.get(p.channel) ?? 0;
      perChannelIndex.set(p.channel, idx + 1);
      return {
        name: p.name,
        channel: p.channel,
        priority: (idx + 1) * 10,
        cost_micros: this.defaults.costs[p.channel],
        rate_limit_per_minute: p.channel === 'inapp' ? 100000 : 6000,
        timeout_ms: this.defaults.timeoutMs,
      };
    });
    if (rows.length > 0) await this.db('provider_configs').insert(rows).onConflict('name').ignore();
    this.cache = undefined;
  }

  private async configs(): Promise<ProviderConfigRow[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.rows;
    const rows = (await this.db('provider_configs').select('*')) as ProviderConfigRow[];
    this.cache = { rows, expires: Date.now() + this.cacheTtlMs };
    return rows;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  async ordered(channel: Channel): Promise<ProviderEntry[]> {
    const rows = await this.configs();
    const entries: ProviderEntry[] = [];
    for (const p of this.providers().filter((x) => x.channel === channel)) {
      const row = rows.find((r) => r.name === p.name) ?? {
        name: p.name,
        channel,
        enabled: true,
        priority: 100,
        cost_micros: this.defaults.costs[channel],
        rate_limit_per_minute: 6000,
        timeout_ms: this.defaults.timeoutMs,
      };
      if (row.enabled) entries.push({ ...row, provider: p });
    }
    return entries.sort((a, b) => a.priority - b.priority);
  }

  async isChannelAvailable(channel: Channel): Promise<boolean> {
    for (const e of await this.ordered(channel)) {
      if (await this.circuit.isAvailable(e.name)) return true;
    }
    return false;
  }

  async status(): Promise<Record<string, unknown>[]> {
    const rows = await this.configs();
    const out: Record<string, unknown>[] = [];
    for (const p of this.providers()) {
      const row = rows.find((r) => r.name === p.name);
      const state = await this.circuit.state(p.name);
      metrics.circuitState.set({ provider: p.name }, circuitGaugeValue(state.status));
      out.push({
        name: p.name,
        channel: p.channel,
        enabled: row?.enabled ?? true,
        priority: row?.priority ?? null,
        rateLimitPerMinute: row?.rate_limit_per_minute ?? null,
        costMicros: row?.cost_micros ?? null,
        circuit: {
          status: state.status,
          consecutiveFailures: state.consecutiveFailures,
          openedAt: state.openedAt ? new Date(state.openedAt).toISOString() : null,
        },
        quota: await p.getQuota(),
      });
    }
    return out;
  }

  async updateConfig(
    name: string,
    patch: Partial<
      Pick<
        ProviderConfigRow,
        'enabled' | 'priority' | 'rate_limit_per_minute' | 'timeout_ms' | 'cost_micros'
      >
    >,
    actor: string,
  ): Promise<void> {
    await this.db('provider_configs')
      .where({ name })
      .update({ ...patch, updated_by: actor, updated_at: this.db.fn.now() });
    this.invalidate();
  }
}
