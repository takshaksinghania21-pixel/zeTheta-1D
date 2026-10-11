import { createSign } from 'node:crypto';
import {
  classifyHttpStatus,
  ProviderError,
  providerFetch,
  readJson,
  retryAfterMs,
  type DeliveryProvider,
  type DeliveryRequest,
  type DeliveryResult,
  type ProviderQuota,
  type ProviderStatus,
  type RecipientValidation,
} from '../../modules/delivery/provider';
import { validateRecipientFormat } from '../../modules/users/contacts';

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
  baseUrl: string;
  tokenUrl: string;
  costMicros: number;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** Firebase Cloud Messaging HTTP v1 adapter using a service-account JWT bearer grant. */
export class FcmPushProvider implements DeliveryProvider {
  readonly channel = 'push' as const;
  private token: { value: string; expiresAt: number } | undefined;

  constructor(
    readonly name: string,
    private readonly cfg: FcmConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private assertion(): string {
    const iat = Math.floor(this.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: this.cfg.clientEmail,
        scope: SCOPE,
        aud: this.cfg.tokenUrl,
        iat,
        exp: iat + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${signer.sign(this.cfg.privateKeyPem).toString('base64url')}`;
  }

  async accessToken(signal: AbortSignal): Promise<string> {
    if (this.token && this.token.expiresAt - 60000 > this.now()) return this.token.value;
    const res = await providerFetch(
      this.cfg.tokenUrl,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: this.assertion(),
        }).toString(),
      },
      signal,
    );
    const body = await readJson(res);
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new ProviderError(
        res.status >= 500 ? 'TRANSIENT' : 'AUTH',
        `FCM_TOKEN_${res.status}`,
        'Failed to obtain FCM access token',
        { httpStatus: res.status },
      );
    }
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.token = { value: body.access_token, expiresAt: this.now() + ttl * 1000 };
    return this.token.value;
  }

  async send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult> {
    const token = await this.accessToken(signal);
    const urgent = req.priority === 'CRITICAL' || req.priority === 'HIGH';
    const res = await providerFetch(
      `${this.cfg.baseUrl}/v1/projects/${encodeURIComponent(this.cfg.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: req.recipient,
            notification: { title: req.content.title ?? '', body: req.content.body },
            data: { notificationId: req.notificationId },
            android: { priority: urgent ? 'high' : 'normal' },
            apns: { headers: { 'apns-priority': urgent ? '10' : '5' } },
          },
        }),
      },
      signal,
    );
    const body = await readJson(res);
    if (res.ok && typeof body.name === 'string')
      return { providerMessageId: body.name, status: 'ACCEPTED', costMicros: this.cfg.costMicros };
    const error = (body.error ?? {}) as {
      status?: string;
      message?: string;
      details?: { errorCode?: string }[];
    };
    const fcmCode =
      error.details?.find((d) => d.errorCode)?.errorCode ?? error.status ?? `HTTP_${res.status}`;
    let kind = classifyHttpStatus(res.status);
    if (
      fcmCode === 'UNREGISTERED' ||
      fcmCode === 'SENDER_ID_MISMATCH' ||
      (fcmCode === 'INVALID_ARGUMENT' && /token/i.test(error.message ?? ''))
    )
      kind = 'INVALID_RECIPIENT';
    if (fcmCode === 'QUOTA_EXCEEDED') kind = 'RATE_LIMITED';
    if (fcmCode === 'UNAVAILABLE' || fcmCode === 'INTERNAL') kind = 'TRANSIENT';
    if (res.status === 401) this.token = undefined;
    const ra = retryAfterMs(res);
    throw new ProviderError(kind, `FCM_${fcmCode}`, `FCM rejected message (${fcmCode})`, {
      httpStatus: res.status,
      ...(ra !== undefined ? { retryAfterMs: ra } : {}),
    });
  }

  getStatus(providerMessageId: string): Promise<ProviderStatus> {
    // FCM exposes no per-message delivery status API (only BigQuery export).
    return Promise.resolve({ providerMessageId, status: 'UNKNOWN' });
  }

  validateRecipient(recipient: string): RecipientValidation {
    return validateRecipientFormat('push', recipient)
      ? { valid: true }
      : { valid: false, reason: 'invalid FCM registration token format' };
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
