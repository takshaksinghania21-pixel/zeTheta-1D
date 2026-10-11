import {
  classifyHttpStatus,
  ProviderError,
  providerFetch,
  readJson,
  retryAfterMs,
  type DeliveryProvider,
  type DeliveryRequest,
  type DeliveryResult,
  type ProviderMessageStatus,
  type ProviderQuota,
  type ProviderStatus,
  type RecipientValidation,
} from '../../modules/delivery/provider';
import { validateRecipientFormat } from '../../modules/users/contacts';

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  baseUrl: string;
  statusCallbackUrl?: string;
  costMicros: number;
}

// https://www.twilio.com/docs/api/errors — recipient-level errors are not retryable.
const INVALID_RECIPIENT_CODES = new Set([
  21211, 21214, 21217, 21219, 21407, 21408, 21612, 21614, 30003, 30005, 30006,
]);
const PERMANENT_CODES = new Set([21610, 30004, 30007, 21606]);

const STATUS_MAP: Record<string, ProviderMessageStatus> = {
  accepted: 'QUEUED',
  scheduled: 'QUEUED',
  queued: 'QUEUED',
  sending: 'QUEUED',
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  undelivered: 'FAILED',
  failed: 'FAILED',
  canceled: 'FAILED',
};

export function mapTwilioStatus(s: string): ProviderMessageStatus {
  return STATUS_MAP[s] ?? 'UNKNOWN';
}

/** Twilio Programmable Messaging adapter (works with Twilio test credentials). */
export class TwilioSmsProvider implements DeliveryProvider {
  readonly channel = 'sms' as const;
  constructor(
    readonly name: string,
    private readonly cfg: TwilioConfig,
  ) {}

  private get auth(): string {
    return `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64')}`;
  }

  async send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult> {
    const form = new URLSearchParams({
      To: req.recipient,
      From: this.cfg.fromNumber,
      Body: req.content.body,
    });
    if (this.cfg.statusCallbackUrl) form.set('StatusCallback', this.cfg.statusCallbackUrl);
    const res = await providerFetch(
      `${this.cfg.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: { authorization: this.auth, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
      signal,
    );
    const body = await readJson(res);
    if (res.ok && typeof body.sid === 'string')
      return { providerMessageId: body.sid, status: 'ACCEPTED', costMicros: this.cfg.costMicros };
    const code = typeof body.code === 'number' ? body.code : 0;
    let kind = classifyHttpStatus(res.status);
    if (INVALID_RECIPIENT_CODES.has(code)) kind = 'INVALID_RECIPIENT';
    else if (PERMANENT_CODES.has(code)) kind = 'PERMANENT';
    const ra = retryAfterMs(res);
    throw new ProviderError(
      kind,
      `TWILIO_${code || res.status}`,
      `Twilio rejected message (HTTP ${res.status}, code ${code})`,
      { httpStatus: res.status, ...(ra !== undefined ? { retryAfterMs: ra } : {}) },
    );
  }

  async getStatus(providerMessageId: string): Promise<ProviderStatus> {
    const ctrl = AbortSignal.timeout(5000);
    const res = await providerFetch(
      `${this.cfg.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages/${encodeURIComponent(providerMessageId)}.json`,
      { headers: { authorization: this.auth } },
      ctrl,
    );
    const body = await readJson(res);
    if (!res.ok) return { providerMessageId, status: 'UNKNOWN' };
    const status = typeof body.status === 'string' ? mapTwilioStatus(body.status) : 'UNKNOWN';
    return {
      providerMessageId,
      status,
      ...(typeof body.error_code === 'number' || typeof body.error_code === 'string'
        ? { errorCode: String(body.error_code) }
        : {}),
    };
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
