import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  actorId?: string;
  actorRole?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a caller-supplied correlation id only if it is well-formed. */
export function normaliseCorrelationId(candidate: unknown): string {
  if (typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)) return candidate;
  return randomUUID();
}

export const CORRELATION_HEADER = 'x-correlation-id';
