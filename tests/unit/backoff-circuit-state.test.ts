import { fixedRandom } from '../../src/common/clock';
import { loadPolicy } from '../../src/config/policy';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  isForwardProgress,
  TERMINAL_STATES,
} from '../../src/domain/state-machine';
import {
  CircuitBreaker,
  InMemoryCircuitStore,
  circuitAcquire,
  INITIAL_CIRCUIT,
} from '../../src/modules/delivery/circuit-breaker';
import { canRetry, computeRetryDelay } from '../../src/modules/retries/backoff';

const policy = loadPolicy();

describe('retry backoff', () => {
  it('uses the assignment profiles per priority', () => {
    expect(policy.retryProfiles.CRITICAL).toEqual({
      maxRetries: 10,
      baseDelayMs: 500,
      maxDelayMs: 60000,
      jitterMaxMs: 1000,
    });
    expect(policy.retryProfiles.HIGH).toMatchObject({
      maxRetries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 300000,
    });
    expect(policy.retryProfiles.MEDIUM).toMatchObject({
      maxRetries: 3,
      baseDelayMs: 5000,
      maxDelayMs: 1800000,
    });
    expect(policy.retryProfiles.LOW).toMatchObject({
      maxRetries: 2,
      baseDelayMs: 30000,
      maxDelayMs: 7200000,
    });
  });

  it('computes min(base*2^attempt + jitter, max) deterministically', () => {
    const p = policy.retryProfiles.CRITICAL;
    expect(computeRetryDelay(0, p, fixedRandom(0))).toBe(500);
    expect(computeRetryDelay(3, p, fixedRandom(0))).toBe(4000);
    expect(computeRetryDelay(3, p, fixedRandom(0.5))).toBe(4500);
    expect(computeRetryDelay(9, p, fixedRandom(0))).toBe(60000); // 256000 capped
  });

  it('keeps jitter within [0, 1000]', () => {
    const p = policy.retryProfiles.HIGH;
    expect(computeRetryDelay(0, p, fixedRandom(0.9999))).toBe(1000 + 1000);
    for (let i = 0; i < 100; i++) {
      const d = computeRetryDelay(1, p, { next: Math.random });
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(3000);
    }
  });

  it('caps at maxDelay and rejects invalid attempts', () => {
    expect(computeRetryDelay(50, policy.retryProfiles.LOW, fixedRandom(1))).toBe(7200000);
    expect(() => computeRetryDelay(-1, policy.retryProfiles.LOW, fixedRandom(0))).toThrow(
      RangeError,
    );
  });

  it('stops retrying when retries are exhausted', () => {
    expect(canRetry(4, policy.retryProfiles.HIGH)).toBe(true);
    expect(canRetry(5, policy.retryProfiles.HIGH)).toBe(false);
    expect(canRetry(10, policy.retryProfiles.CRITICAL)).toBe(false);
  });
});

describe('circuit breaker', () => {
  const cfg = {
    failureThreshold: 3,
    failureWindowMs: 60000,
    openDurationMs: 1000,
    halfOpenMaxTrials: 1,
  };

  it('opens after threshold failures in the window, half-opens after the cool-down and closes on success', async () => {
    let now = 0;
    const cb = new CircuitBreaker(new InMemoryCircuitStore(), cfg, () => now);
    for (let i = 0; i < 3; i++) await cb.recordFailure('p');
    expect((await cb.state('p')).status).toBe('OPEN');
    expect(await cb.acquire('p')).toBe(false);
    expect(await cb.remainingOpenMs('p')).toBe(1000);
    now = 1000;
    expect(await cb.acquire('p')).toBe(true); // trial
    expect((await cb.state('p')).status).toBe('HALF_OPEN');
    expect(await cb.acquire('p')).toBe(false); // only one trial
    await cb.recordSuccess('p');
    expect((await cb.state('p')).status).toBe('CLOSED');
  });

  it('re-opens when the half-open trial fails', async () => {
    let now = 0;
    const cb = new CircuitBreaker(new InMemoryCircuitStore(), cfg, () => now);
    for (let i = 0; i < 3; i++) await cb.recordFailure('p');
    now = 1500;
    await cb.acquire('p');
    await cb.recordFailure('p');
    const s = await cb.state('p');
    expect(s.status).toBe('OPEN');
    expect(s.openedAt).toBe(1500);
  });

  it('counts failures in the window even when successes interleave (failure rate, not streak)', async () => {
    const cb = new CircuitBreaker(new InMemoryCircuitStore(), cfg, () => 0);
    await cb.recordFailure('p');
    await cb.recordFailure('p');
    await cb.recordSuccess('p');
    await cb.recordFailure('p');
    expect((await cb.state('p')).status).toBe('OPEN');
  });

  it('starts a new window once failureWindowMs has passed (PDF: 5 failures in 60 s)', async () => {
    let now = 0;
    const cb = new CircuitBreaker(new InMemoryCircuitStore(), cfg, () => now);
    await cb.recordFailure('p');
    await cb.recordFailure('p');
    now = 60000;
    await cb.recordFailure('p');
    expect(await cb.state('p')).toMatchObject({
      status: 'CLOSED',
      failures: 1,
      windowStartedAt: 60000,
    });
  });

  it('uses the Appendix B thresholds in the shipped policy', () => {
    expect(policy.circuitBreaker).toMatchObject({
      failureThreshold: 5,
      failureWindowMs: 60000,
      openDurationMs: 60000,
      halfOpenMaxTrials: 1,
    });
  });

  it('admits a new trial if a half-open trial never reported back', () => {
    const half = {
      ...INITIAL_CIRCUIT,
      status: 'HALF_OPEN' as const,
      halfOpenInFlight: 1,
      openedAt: 0,
    };
    expect(circuitAcquire(half, 500, cfg).allowed).toBe(false);
    expect(circuitAcquire(half, 1000, cfg).allowed).toBe(true);
  });

  it('isolates providers', async () => {
    const cb = new CircuitBreaker(new InMemoryCircuitStore(), cfg, () => 0);
    for (let i = 0; i < 3; i++) await cb.recordFailure('a');
    expect(await cb.isAvailable('a')).toBe(false);
    expect(await cb.isAvailable('b')).toBe(true);
  });
});

describe('notification state machine', () => {
  it('allows the happy path', () => {
    const path = ['CREATED', 'ENRICHED', 'ROUTED', 'QUEUED', 'SENT', 'DELIVERED', 'READ'] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });
  it('allows the alternate states from the right places', () => {
    expect(canTransition('ROUTED', 'CAPPED')).toBe(true);
    expect(canTransition('ROUTED', 'QUIET')).toBe(true);
    expect(canTransition('ENRICHED', 'DND')).toBe(true);
    expect(canTransition('QUEUED', 'RETRYING')).toBe(true);
    expect(canTransition('RETRYING', 'DLQ')).toBe(true);
    expect(canTransition('SENT', 'BOUNCED')).toBe(true);
    expect(canTransition('DLQ', 'QUEUED')).toBe(true);
    expect(canTransition('QUIET', 'QUEUED')).toBe(true);
  });
  it('rejects illegal transitions', () => {
    expect(canTransition('CREATED', 'SENT')).toBe(false);
    expect(canTransition('DELIVERED', 'QUEUED')).toBe(false);
    expect(canTransition('READ', 'DELIVERED')).toBe(false);
    expect(() => assertTransition('CAPPED', 'QUEUED')).toThrow(/not allowed/);
  });
  it('has terminal states with no exits', () => {
    expect(TERMINAL_STATES).toEqual(
      expect.arrayContaining([
        'READ',
        'CAPPED',
        'DND',
        'FAILED',
        'BOUNCED',
        'SUPPRESSED',
        'DIGESTED',
      ]),
    );
    for (const s of TERMINAL_STATES) expect(allowedTransitions(s)).toHaveLength(0);
  });
  it('never moves receipts backwards', () => {
    expect(isForwardProgress('DELIVERED', 'SENT')).toBe(false);
    expect(isForwardProgress('SENT', 'READ')).toBe(true);
  });
});
