export const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'inapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REGULATORY_CLASSES = ['TRANSACTIONAL', 'SERVICE', 'PROMOTIONAL'] as const;
export type RegulatoryClass = (typeof REGULATORY_CLASSES)[number];

export const CATEGORIES = ['TRANSACTION', 'RISK', 'SIP', 'MARKET', 'REGULATORY'] as const;
export type Category = (typeof CATEGORIES)[number];

export const LOCALES = ['en', 'hi', 'mr', 'ta', 'te'] as const;
export type Locale = (typeof LOCALES)[number];

export const ROLES = ['ADMIN', 'OPERATOR', 'SERVICE', 'USER'] as const;
export type Role = (typeof ROLES)[number];

export const CONSENT_PURPOSES = ['TRANSACTIONAL', 'SERVICE', 'PROMOTIONAL'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const NOTIFICATION_STATES = [
  'CREATED',
  'ENRICHED',
  'ROUTED',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'CAPPED',
  'QUIET',
  'DND',
  'FAILED',
  'RETRYING',
  'DLQ',
  'BOUNCED',
  // Implementation extensions (documented in ARCHITECTURE.md):
  'SUPPRESSED', // blocked by consent / preference re-check / budget policy
  'DIGESTED', // folded into a digest notification
] as const;
export type NotificationState = (typeof NOTIFICATION_STATES)[number];

export const SEGMENTS = ['RETAIL', 'HNI', 'NEW_INVESTOR', 'DORMANT'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const DIGEST_FREQUENCIES = ['HOURLY', 'DAILY', 'WEEKLY'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}
