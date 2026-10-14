import { z } from 'zod';
import type { Channel, Priority } from '../../utils/types';

/**
 * PDF Appendix A (p.61–66) request/response contract. The native API is
 * camelCase; requests in the PDF's snake_case shape are accepted alongside it
 * and answered in the PDF shape (see docs/api-specification.yaml).
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
/** Appendix A uses `usr_<uuid>` while §A8 stores a UUID: both are accepted. */
export const pdfUserId = z
  .string()
  .regex(new RegExp(`^(usr_)?${UUID}$`), 'must be a UUID, optionally prefixed with usr_')
  .transform((v) => v.replace(/^usr_/, ''));

export const pdfEventEnvelopeSchema = z
  .strictObject({
    event_type: z.string().regex(/^[A-Z]{4}-\d{3}$/),
    event_id: z.string().min(1).max(50),
    source_system: z.string().min(1).max(64),
    timestamp: z.iso.datetime({ offset: true }),
    /** §A8: 1 = CRITICAL … 5 = LOW. The taxonomy priority stays authoritative. */
    priority: z.number().int().min(1).max(5).optional(),
    user_id: pdfUserId,
    payload: z.record(z.string(), z.unknown()),
    idempotency_key: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9:_|./-]+$/)
      .optional(),
  })
  .meta({ id: 'PdfEventEnvelope' });
export type PdfEventEnvelope = z.infer<typeof pdfEventEnvelopeSchema>;

export const isPdfEnvelope = (raw: unknown): boolean =>
  typeof raw === 'object' && raw !== null && 'event_type' in raw;

const toCamel = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const toSnake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Recursively converts object keys from snake_case to camelCase. */
export function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (typeof v !== 'object' || v === null) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [toCamel(k), camelKeys(x)]));
}

export const PRIORITY_NUMBER: Record<Priority, number> = {
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 5,
};
export const pdfChannel = (c: Channel): string => (c === 'inapp' ? 'in_app' : c);
export const nativeChannel = (c: string): Channel => (c === 'in_app' ? 'inapp' : c) as Channel;

/** Appendix A error body: `{ error, message, details: [{ field, error }], request_id }`. */
export function pdfErrorBody(
  code: string,
  message: string,
  details: { path?: string; message: string }[],
  requestId: unknown,
): Record<string, unknown> {
  const validation = ['VALIDATION_ERROR', 'EVENT_SCHEMA_INVALID', 'UNKNOWN_EVENT_TYPE'];
  return {
    error: validation.includes(code) ? 'VALIDATION_FAILED' : code,
    message: validation.includes(code) ? 'Event payload validation failed' : message,
    details: details.map((d) => ({
      field: (d.path ?? '')
        .replace(/^body\./, '')
        .split('.')
        .map(toSnake)
        .join('.'),
      error: d.message,
    })),
    request_id: requestId,
  };
}
