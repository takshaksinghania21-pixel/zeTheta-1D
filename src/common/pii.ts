/** PII masking helpers used by logs, API responses and audit metadata. */

/** PDF §A10.2 format: `+91XXXX1234` (country code and last four digits kept). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return 'X'.repeat(digits.length);
  const country = phone.startsWith('+') && digits.length > 10 ? `+${digits.slice(0, -10)}` : '';
  return `${country}XXXX${digits.slice(-4)}`;
}

/** PDF §A10.2 format: `s***@domain.com`. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***@${email.slice(at + 1)}`;
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export function maskContact(channel: string, value: string): string {
  switch (channel) {
    case 'sms':
    case 'whatsapp':
      return maskPhone(value);
    case 'email':
      return maskEmail(value);
    default:
      return maskToken(value);
  }
}

const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|api[-_]?key|private[-_]?key|cookie|credential/i;
const CONTACT_KEY = /phone|mobile|msisdn|email|recipient|^to$|address|contact/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
// Standalone phone-like digit runs only (not digits inside UUIDs, ids or hashes).
const PHONE_VALUE = /(?<![\w-])\+?\d{10,15}(?![\w-])/g;
const NEVER_MASK = new Set([
  'correlationId',
  'correlation_id',
  'request_id',
  'eventId',
  'notificationId',
  'userId',
  'id',
  'requestId',
  'transitionId',
  'dlqId',
]);

/** Deep-sanitises arbitrary data for logging. Never mutates the input. */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeForLog(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_MASK.has(key)) out[key] = v;
    else if (SENSITIVE_KEY.test(key)) out[key] = '[REDACTED]';
    else if (CONTACT_KEY.test(key) && typeof v === 'string') out[key] = maskContactLike(v);
    else out[key] = sanitizeForLog(v, depth + 1);
  }
  return out;
}

function maskContactLike(v: string): string {
  if (v.includes('@')) return maskEmail(v);
  if (/^\+?[\d\s-]{6,}$/.test(v)) return maskPhone(v);
  return maskToken(v);
}

export function scrubString(s: string): string {
  return s.replace(EMAIL_VALUE, (m) => maskEmail(m)).replace(PHONE_VALUE, (m) => maskPhone(m));
}
