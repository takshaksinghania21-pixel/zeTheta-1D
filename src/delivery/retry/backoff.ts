import type { RandomSource } from '../../utils/clock';

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
