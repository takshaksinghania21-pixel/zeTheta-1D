import type { RandomSource } from '../../common/clock';

export interface RetryProfile {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterMaxMs: number;
}

/**
 * retryDelay = min(baseDelay * 2^attempt + randomJitter(0, jitterMax), maxDelay)
 * `attempt` is the zero-based retry index (0 for the first retry).
 */
export function computeRetryDelay(
  attempt: number,
  profile: RetryProfile,
  random: RandomSource,
): number {
  if (attempt < 0 || !Number.isInteger(attempt))
    throw new RangeError('attempt must be a non-negative integer');
  const exponential = profile.baseDelayMs * 2 ** Math.min(attempt, 40);
  const jitter = Math.floor(random.next() * (profile.jitterMaxMs + 1));
  return Math.min(exponential + jitter, profile.maxDelayMs);
}

/** `retriesUsed` = retries already performed (not counting the initial attempt). */
export function canRetry(retriesUsed: number, profile: RetryProfile): boolean {
  return retriesUsed < profile.maxRetries;
}

/**
 * RabbitMQ delay band for a retry. Each band is a queue whose messages carry a
 * per-message TTL inside [2^k, 2^(k+1)) ms, bounding head-of-line lateness to
 * the band width while preserving the jittered delay.
 */
export const MIN_BAND = 9; // 512 ms
export const MAX_BAND = 23; // ~2.3 h
export function retryBand(delayMs: number): number {
  if (delayMs <= 1) return MIN_BAND;
  const k = Math.floor(Math.log2(delayMs));
  return Math.max(MIN_BAND, Math.min(MAX_BAND, k));
}
export function allRetryBands(): number[] {
  const out: number[] = [];
  for (let k = MIN_BAND; k <= MAX_BAND; k++) out.push(k);
  return out;
}
