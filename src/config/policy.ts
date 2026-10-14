import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import {
  CATEGORIES,
  CHANNELS,
  DIGEST_FREQUENCIES,
  LOCALES,
  PRIORITIES,
  REGULATORY_CLASSES,
} from '../utils/types';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');
const window = z.object({ limit: z.number().int().min(1), windowSeconds: z.number().int().min(1) });
const retryProfile = z.object({
  maxRetries: z.number().int().min(0).max(50),
  baseDelayMs: z.number().int().min(1),
  maxDelayMs: z.number().int().min(1),
  jitterMaxMs: z.number().int().min(0),
});
const channelBools = z.object(
  Object.fromEntries(CHANNELS.map((c) => [c, z.boolean()])) as Record<
    (typeof CHANNELS)[number],
    z.ZodBoolean
  >,
);
const partialChannelBools = channelBools.partial();
const categoryPref = z.object({
  enabled: z.boolean().optional(),
  channels: z.array(z.enum(CHANNELS)).optional(),
});
const digest = z.object({
  enabled: z.boolean(),
  frequency: z.enum(DIGEST_FREQUENCIES),
  deliveryTime: hhmm,
  categories: z.array(z.enum(CATEGORIES)),
});

export const segmentOverrideSchema = z.object({
  channels: partialChannelBools.optional(),
  categories: z.partialRecord(z.enum(CATEGORIES), categoryPref).optional(),
  digest: digest.partial().optional(),
});
export type SegmentOverride = z.infer<typeof segmentOverrideSchema>;

const policySchema = z.object({
  version: z.number().int(),
  retryProfiles: z.record(z.enum(PRIORITIES), retryProfile),
  queuePriority: z.record(z.enum(PRIORITIES), z.number().int().min(0).max(10)),
  frequencyCaps: z.object({
    countedChannels: z.array(z.enum(CHANNELS)),
    global: window,
    channels: z.partialRecord(z.enum(CHANNELS), window),
    category: window,
    sameEventCooldownSeconds: z.number().int().min(0),
    countExemptEvents: z.boolean(),
    digestSuggestion: z.object({
      /** Suggest a digest when the window's average exceeds this many per day. */
      dailyThreshold: z.number().int().min(1),
      windowSeconds: z.number().int().min(60),
    }),
  }),
  quietHours: z.object({
    default: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
    minimumWindowMinutes: z.number().int().min(0).max(1440),
    appliesToChannels: z.array(z.enum(CHANNELS)),
    morningDigestThreshold: z.number().int().min(1),
  }),
  defaults: z.object({
    timezone: z.string(),
    locale: z.enum(LOCALES),
    channels: channelBools,
    digest,
  }),
  segments: z.record(z.string(), segmentOverrideSchema),
  costs: z.object({
    perMessageMicros: z.record(z.enum(CHANNELS), z.number().int().min(0)),
    dailyBudgetMicros: z.partialRecord(z.enum(CHANNELS), z.number().int().min(0)),
    /** Per-user spend limits (PDF §A3.2 priority 4); omitted = unlimited. */
    userDailyBudgetMicros: z.number().int().min(0).optional(),
    userMonthlyBudgetMicros: z.number().int().min(0).optional(),
    budgetExemptPriorities: z.array(z.enum(PRIORITIES)),
  }),
  /** Share of each provider's quota held back for CRITICAL traffic (no priority inversion). */
  delivery: z
    .object({ criticalReservePercent: z.number().int().min(0).max(90) })
    .default({ criticalReservePercent: 20 }),
  /** Delivery optimisation from per-user engagement history (PDF §A3.2 priority 3). */
  routing: z
    .object({
      engagementMinSamples: z.number().int().min(1),
      ignoreBelowRate: z.number().min(0).max(1),
      preferAboveRate: z.number().min(0).max(1),
    })
    .default({ engagementMinSamples: 20, ignoreBelowRate: 0.05, preferAboveRate: 0.2 }),
  templates: z.object({
    supportedLocales: z.array(z.enum(LOCALES)),
    fallbackLocale: z.enum(LOCALES),
    smsMaxChars: z.number().int().min(70).max(1600).default(160),
  }),
  circuitBreaker: z.object({
    failureThreshold: z.number().int().min(1),
    failureWindowMs: z.number().int().min(100).default(60000),
    openDurationMs: z.number().int().min(100),
    halfOpenMaxTrials: z.number().int().min(1),
  }),
  dnd: z.object({
    appliesToClasses: z.array(z.enum(REGULATORY_CLASSES)),
    appliesToChannels: z.array(z.enum(CHANNELS)),
    promotionalCategory: z.string(),
    onStaleOrUnavailable: z.record(z.enum(REGULATORY_CLASSES), z.enum(['ALLOW', 'BLOCK'])),
  }),
});

export type NotificationPolicy = z.infer<typeof policySchema>;

export function parsePolicy(text: string): NotificationPolicy {
  const policy = policySchema.parse(YAML.parse(text));
  const { start, end } = policy.quietHours.default;
  const minutes = (toMinutes(end) - toMinutes(start) + 1440) % 1440;
  if (policy.quietHours.default.enabled && minutes < policy.quietHours.minimumWindowMinutes) {
    throw new Error('Default quiet hours are shorter than the minimum window');
  }
  return policy;
}

export function loadPolicy(
  file = path.resolve(__dirname, '../../config/notification-policy.yaml'),
): NotificationPolicy {
  return parsePolicy(readFileSync(file, 'utf8'));
}

export function toMinutes(hhmmValue: string): number {
  const [h, m] = hhmmValue.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
