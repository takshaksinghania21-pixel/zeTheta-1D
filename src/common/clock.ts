export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Deterministic clock for tests and simulations. */
export class ManualClock implements Clock {
  private current: number;
  constructor(start: Date | string | number = '2026-01-15T10:00:00.000Z') {
    this.current = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(to: Date | string | number): void {
    this.current = new Date(to).getTime();
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export interface RandomSource {
  /** Returns a float in [0, 1). */
  next(): number;
}

export const mathRandom: RandomSource = { next: () => Math.random() };

export function fixedRandom(value: number): RandomSource {
  return { next: () => value };
}
