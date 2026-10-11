export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'EVENT_SCHEMA_INVALID'
  | 'UNKNOWN_EVENT_TYPE'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'RATE_LIMITED'
  | 'WEBHOOK_SIGNATURE_INVALID'
  | 'TEMPLATE_INVALID'
  | 'TEMPLATE_NOT_FOUND'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  path?: string;
  message: string;
  code?: string;
}

/**
 * Base application error. `expose` controls whether `message` and `details`
 * may be returned to API clients; internal errors are always masked.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details: ErrorDetail[] = [],
    readonly expose = true,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: ErrorDetail[] = [], code: ErrorCode = 'VALIDATION_ERROR') {
    super(code, code === 'VALIDATION_ERROR' ? 400 : 422, message, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', 404, id ? `${resource} '${id}' not found` : `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = 'CONFLICT') {
    super(code, 409, message);
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super('FORBIDDEN', 403, message);
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 429, 'Rate limit exceeded');
  }
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super('INVALID_STATE_TRANSITION', 409, `Transition ${from} -> ${to} is not allowed`);
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(dependency: string, cause?: unknown) {
    super('DEPENDENCY_UNAVAILABLE', 503, `${dependency} is unavailable`, [], true, { cause });
  }
}

/** Errors that a message consumer should not retry (poison / invalid input). */
export class NonRetryableError extends Error {
  constructor(
    message: string,
    readonly reasonCode: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NonRetryableError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}
