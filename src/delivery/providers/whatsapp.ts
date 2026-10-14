import {
  classifyHttpStatus,
  ProviderError,
  providerFetch,
  readJson,
  type DeliveryProvider,
  type DeliveryRequest,
  type DeliveryResult,
  type ProviderErrorKind,
  type ProviderQuota,
  type ProviderStatus,
  type RecipientValidation,
} from './provider';
import { validateRecipientFormat } from '../../database/models/contacts';

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  apiVersion: string;
  baseUrl: string;
  costMicros: number;
}

// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const ERROR_KINDS: Record<number, ProviderErrorKind> = {
  131026: 'INVALID_RECIPIENT', // message undeliverable / not a WhatsApp user
  131047: 'PERMANENT', // re-engagement window expired: requires an approved template
  131051: 'PERMANENT',
  130429: 'RATE_LIMITED',
  131048: 'RATE_LIMITED',
  131056: 'RATE_LIMITED',
  80007: 'RATE_LIMITED',
  190: 'AUTH',
  131000: 'TRANSIENT',
  131016: 'TRANSIENT',
};

/**
 * WhatsApp Cloud API adapter. Note: business-initiated messages outside the
 * 24h customer-care window must use pre-approved templates; this adapter sends
 * text bodies, which works for the Meta test number and in-window messages.
 */
export class WhatsAppCloudProvider implements DeliveryProvider {
  readonly channel = 'whatsapp' as const;
  constructor(
    readonly name: string,
    private readonly cfg: WhatsAppConfig,
  ) {}

  async send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult> {
    const res = await providerFetch(
      `${this.cfg.baseUrl}/${this.cfg.apiVersion}/${encodeURIComponent(this.cfg.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: req.recipient.replace(/^\+/, ''),
          type: 'text',
          text: { preview_url: false, body: req.content.body },
          // Echoed back by Meta in status webhooks (end-to-end tracing, PDF §A11.1).
          biz_opaque_callback_data: req.correlationId,
        }),
      },
      signal,
    );
    const body = await readJson(res);
    const messages = body.messages as { id?: string }[] | undefined;
    const id = messages?.[0]?.id;
    if (res.ok && id)
      return { providerMessageId: id, status: 'ACCEPTED', costMicros: this.cfg.costMicros };
    const err = (body.error ?? {}) as { code?: number; message?: string };
    const kind =
      (err.code !== undefined ? ERROR_KINDS[err.code] : undefined) ??
      classifyHttpStatus(res.status);
    throw new ProviderError(
      kind,
      `WA_${err.code ?? res.status}`,
      `WhatsApp rejected message (${err.code ?? res.status})`,
      { httpStatus: res.status },
    );
  }

  getStatus(providerMessageId: string): Promise<ProviderStatus> {
    // Status updates are delivered through the webhook (sent/delivered/read/failed).
    return Promise.resolve({ providerMessageId, status: 'UNKNOWN' });
  }

  validateRecipient(recipient: string): RecipientValidation {
    return validateRecipientFormat('whatsapp', recipient)
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
