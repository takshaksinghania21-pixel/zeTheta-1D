import type { Channel, Priority } from '../../domain/types';
import type { RenderedContent } from '../templates/engine';

export type ProviderErrorKind =
  | 'TRANSIENT'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH'
  | 'INVALID_RECIPIENT'
  | 'PERMANENT';

/** Normalised provider failure. `kind` drives retry, failover and circuit decisions. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly code: string,
    message: string,
    readonly options: { retryAfterMs?: number; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Errors that warrant trying again later (possibly on another provider). */
  get retryable(): boolean {
    return (
      this.kind === 'TRANSIENT' ||
      this.kind === 'TIMEOUT' ||
      this.kind === 'RATE_LIMITED' ||
      this.kind === 'AUTH'
    );
  }

  /** Errors that indicate the provider itself is unhealthy (feed the circuit breaker). */
  get countsAgainstProvider(): boolean {
    return this.kind === 'TRANSIENT' || this.kind === 'TIMEOUT' || this.kind === 'AUTH';
  }
}

export interface DeliveryRequest {
  notificationId: string;
  channel: Channel;
  /** Decrypted address (phone, email, push token) or user id for in-app. */
  recipient: string;
  content: RenderedContent;
  priority: Priority;
  correlationId: string;
  userId: string;
}

export interface DeliveryResult {
  providerMessageId: string;
  /** ACCEPTED: handed to the provider. Providers never claim DELIVERED synchronously. */
  status: 'ACCEPTED';
  costMicros: number;
}

export type ProviderMessageStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN';

export interface ProviderStatus {
  providerMessageId: string;
  status: ProviderMessageStatus;
  errorCode?: string;
}

export interface ProviderQuota {
  limitPerMinute: number | null;
  remaining: number | null;
  resetAt: string | null;
  source: 'local-rate-limiter' | 'provider' | 'unlimited';
}

export interface RecipientValidation {
  valid: boolean;
  reason?: string;
}

export interface DeliveryProvider {
  readonly name: string;
  readonly channel: Channel;
  send(req: DeliveryRequest, signal: AbortSignal): Promise<DeliveryResult>;
  getStatus(providerMessageId: string): Promise<ProviderStatus>;
  validateRecipient(recipient: string): RecipientValidation;
  getQuota(): Promise<ProviderQuota>;
}

/** Shared HTTP status → error-kind mapping used by REST-based adapters. */
export function classifyHttpStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 408 || status >= 500) return 'TRANSIENT';
  if (status === 404) return 'INVALID_RECIPIENT';
  return 'PERMANENT';
}

/** Wraps fetch with an abort signal and converts network failures to ProviderErrors. */
export async function providerFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (signal.aborted) throw new ProviderError('TIMEOUT', 'TIMEOUT', 'Provider request timed out');
    throw new ProviderError(
      'TRANSIENT',
      'NETWORK_ERROR',
      `Network error: ${(err as Error).message}`,
    );
  }
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

export function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
