import pino, { type DestinationStream, type Logger } from 'pino';
import { currentContext } from './context';
import { sanitizeForLog } from './pii';

export type { Logger } from 'pino';

/**
 * Structured JSON logger. Every line carries an ISO-8601 timestamp, level label,
 * service name and the correlation id of the active async context. Context
 * objects are sanitised (PII masked, secrets redacted) before serialisation.
 */
export function createLogger(
  options: { service: string; level: string; component?: string },
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: options.level,
      messageKey: 'message',
      base: {
        service: options.service,
        ...(options.component ? { component: options.component } : {}),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => sanitizeForLog(obj) as Record<string, unknown>,
      },
      mixin: () => {
        const ctx = currentContext();
        return ctx ? { correlationId: ctx.correlationId } : {};
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.password',
          '*.secret',
          '*.accessToken',
          '*.refreshToken',
        ],
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}

let rootLogger: Logger | undefined;

export function getLogger(): Logger {
  rootLogger ??= createLogger({
    service: process.env.SERVICE_NAME ?? 'zetheta-notification-engine',
    level: process.env.LOG_LEVEL ?? 'info',
  });
  return rootLogger;
}

export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}
