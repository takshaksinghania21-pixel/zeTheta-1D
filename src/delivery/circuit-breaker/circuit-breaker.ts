export type CircuitStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitState {
  status: CircuitStatus;
  /** Failures counted in the current window (CLOSED) or since opening. */
  failures: number;
  /** Start of the current failure-counting window (CLOSED only). */
  windowStartedAt: number | null;
  openedAt: number | null;
  halfOpenInFlight: number;
}

export interface CircuitConfig {
  /** Opens after this many failures within failureWindowMs (PDF: 5 in 60 s). */
  failureThreshold: number;
  failureWindowMs: number;
  openDurationMs: number;
  halfOpenMaxTrials: number;
}

export const INITIAL_CIRCUIT: CircuitState = {
  status: 'CLOSED',
  failures: 0,
  windowStartedAt: null,
  openedAt: null,
  halfOpenInFlight: 0,
};

/** Pure transition: may a request proceed? Returns the next state and decision. */
export function circuitAcquire(
  s: CircuitState,
  now: number,
  cfg: CircuitConfig,
): { allowed: boolean; next: CircuitState } {
  if (s.status === 'CLOSED') return { allowed: true, next: s };
  if (s.status === 'OPEN') {
    if (s.openedAt !== null && now - s.openedAt >= cfg.openDurationMs) {
      // openedAt is reused as the trial start marker while HALF_OPEN.
      return {
        allowed: true,
        next: { ...s, status: 'HALF_OPEN', halfOpenInFlight: 1, openedAt: now },
      };
    }
    return { allowed: false, next: s };
  }
  if (s.halfOpenInFlight < cfg.halfOpenMaxTrials) {
    return { allowed: true, next: { ...s, halfOpenInFlight: s.halfOpenInFlight + 1 } };
  }
  // A trial whose outcome was never reported (e.g. worker crash) must not wedge
  // the circuit: after another open period a fresh trial is admitted.
  if (s.openedAt !== null && now - s.openedAt >= cfg.openDurationMs) {
    return { allowed: true, next: { ...s, halfOpenInFlight: 1, openedAt: now } };
  }
  return { allowed: false, next: s };
}

/** A successful trial closes the circuit; successes while CLOSED keep the failure window. */
export function circuitOnSuccess(s: CircuitState): CircuitState {
  return s.status === 'CLOSED' ? s : { ...INITIAL_CIRCUIT };
}

export function circuitOnFailure(s: CircuitState, now: number, cfg: CircuitConfig): CircuitState {
  const open = (failures: number): CircuitState => ({
    status: 'OPEN',
    failures,
    windowStartedAt: null,
    openedAt: now,
    halfOpenInFlight: 0,
  });
  if (s.status !== 'CLOSED') return open(s.failures + 1);
  const fresh = s.windowStartedAt === null || now - s.windowStartedAt >= cfg.failureWindowMs;
  const failures = fresh ? 1 : s.failures + 1;
  if (failures >= cfg.failureThreshold) return open(failures);
  return { ...s, failures, windowStartedAt: fresh ? now : s.windowStartedAt };
}

/** Whether a new request could currently be attempted (read-only, for routing). */
export function circuitAvailable(s: CircuitState, now: number, cfg: CircuitConfig): boolean {
  return circuitAcquire(s, now, cfg).allowed;
}

export function circuitGaugeValue(status: CircuitStatus): number {
  return status === 'CLOSED' ? 0 : status === 'HALF_OPEN' ? 1 : 2;
}

export interface CircuitStore {
  get(provider: string): Promise<CircuitState>;
  /** Atomically decides whether a request may proceed (may move OPEN → HALF_OPEN). */
  acquire(provider: string, now: number, cfg: CircuitConfig): Promise<boolean>;
  onSuccess(provider: string): Promise<CircuitStatus>;
  onFailure(provider: string, now: number, cfg: CircuitConfig): Promise<CircuitStatus>;
  reset(provider: string): Promise<void>;
}

/** Reference implementation built directly on the pure reducer. */
export class InMemoryCircuitStore implements CircuitStore {
  private readonly states = new Map<string, CircuitState>();
  private read(p: string): CircuitState {
    return this.states.get(p) ?? { ...INITIAL_CIRCUIT };
  }
  get(provider: string): Promise<CircuitState> {
    return Promise.resolve(this.read(provider));
  }
  acquire(provider: string, now: number, cfg: CircuitConfig): Promise<boolean> {
    const { allowed, next } = circuitAcquire(this.read(provider), now, cfg);
    this.states.set(provider, next);
    return Promise.resolve(allowed);
  }
  onSuccess(provider: string): Promise<CircuitStatus> {
    const next = circuitOnSuccess(this.read(provider));
    this.states.set(provider, next);
    return Promise.resolve(next.status);
  }
  onFailure(provider: string, now: number, cfg: CircuitConfig): Promise<CircuitStatus> {
    const next = circuitOnFailure(this.read(provider), now, cfg);
    this.states.set(provider, next);
    return Promise.resolve(next.status);
  }
  reset(provider: string): Promise<void> {
    this.states.delete(provider);
    return Promise.resolve();
  }
}

/** Circuit breaker facade over a (shared) store. */
export class CircuitBreaker {
  constructor(
    private readonly store: CircuitStore,
    private readonly cfg: CircuitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  acquire(provider: string): Promise<boolean> {
    return this.store.acquire(provider, this.now(), this.cfg);
  }

  async isAvailable(provider: string): Promise<boolean> {
    return circuitAvailable(await this.store.get(provider), this.now(), this.cfg);
  }

  state(provider: string): Promise<CircuitState> {
    return this.store.get(provider);
  }

  recordSuccess(provider: string): Promise<CircuitStatus> {
    return this.store.onSuccess(provider);
  }

  recordFailure(provider: string): Promise<CircuitStatus> {
    return this.store.onFailure(provider, this.now(), this.cfg);
  }

  reset(provider: string): Promise<void> {
    return this.store.reset(provider);
  }

  /** Remaining time before an OPEN circuit allows a trial request. */
  async remainingOpenMs(provider: string): Promise<number> {
    const s = await this.store.get(provider);
    if (s.status !== 'OPEN' || s.openedAt === null) return 0;
    return Math.max(0, this.cfg.openDurationMs - (this.now() - s.openedAt));
  }
}
