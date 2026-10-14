import {
  classifyHttpStatus,
  ProviderError,
  providerFetch,
  readJson,
  type DeliveryProvider,
  type DeliveryRequest,
  type DeliveryResult,
  type ProviderQuota,
  type ProviderStatus,
  type RecipientValidation,
} from './provider';
import { validateRecipientFormat } from '../../database/models/contacts';

export interface Msg91Config {
  authKey: string;
  flowId: string;
  baseUrl: string;
  costMicros: number;
}

/**
 * MSG91 Flow API adapter. Indian SMS requires DLT-registered templates: the
 * configured flow must expose a `##message##` variable. Delivery reports arrive
 * through the MSG91 webhook (authenticated with a shared secret header).
 */
export class Msg91SmsProvider implements DeliveryProvider {
  readonly channel = 'sms' as const;
  constructor(
    readonly name: string,
    private readonly cfg: Msg91Config,
  ) {}

  async send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult> {
    const res = await providerFetch(
      `${this.cfg.baseUrl}/api/v5/flow`,
      {
        method: 'POST',
        headers: {
          authkey: this.cfg.authKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          template_id: this.cfg.flowId,
          short_url: '0',
          recipients: [{ mobiles: req.recipient.replace(/^\+/, ''), message: req.content.body }],
        }),
      },
      signal,
    );
    const body = await readJson(res);
    if (res.ok && body.type === 'success' && typeof body.message === 'string') {
      return {
        providerMessageId: body.message,
        status: 'ACCEPTED',
        costMicros: this.cfg.costMicros,
      };
    }
    const message = typeof body.message === 'string' ? body.message : 'unknown error';
    let kind = res.ok ? 'PERMANENT' : classifyHttpStatus(res.status);
    if (/invalid (mobile|number)/i.test(message)) kind = 'INVALID_RECIPIENT';
    if (/authentication|auth key/i.test(message)) kind = 'AUTH';
    throw new ProviderError(
      kind,
      `MSG91_${res.status}`,
      `MSG91 rejected message: ${message.slice(0, 120)}`,
      { httpStatus: res.status },
    );
  }

  getStatus(providerMessageId: string): Promise<ProviderStatus> {
    return Promise.resolve({ providerMessageId, status: 'UNKNOWN' });
  }

  validateRecipient(recipient: string): RecipientValidation {
    return validateRecipientFormat('sms', recipient)
      ? { valid: true }
      : { valid: false, reason: 'not an E.164 number' };
  }

  getQuota(): Promise<ProviderQuota> {
    return Promise.resolve({
      limitPerMinute: null,
      remaining: null,
      resetAt: null,
      source: 'local-rate-limiter',
    });
  }
}
