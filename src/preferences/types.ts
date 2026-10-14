import { z } from 'zod';
import {
  CATEGORIES,
  CHANNELS,
  DIGEST_FREQUENCIES,
  LOCALES,
  type Category,
  type Channel,
  type DigestFrequency,
  type Locale,
} from '../utils/types';

export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');

export const channelPrefsSchema = z.strictObject(
  Object.fromEntries(CHANNELS.map((c) => [c, z.boolean().optional()])) as Record<
    Channel,
    z.ZodOptional<z.ZodBoolean>
  >,
);
export const categoryPrefSchema = z.strictObject({
  enabled: z.boolean().optional(),
  channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length).optional(),
});
export const categoryPrefsSchema = z.strictObject(
  Object.fromEntries(CATEGORIES.map((c) => [c, categoryPrefSchema.optional()])) as Record<
    Category,
    z.ZodOptional<typeof categoryPrefSchema>
  >,
);
export const digestPrefsSchema = z.strictObject({
  enabled: z.boolean(),
  frequency: z.enum(DIGEST_FREQUENCIES),
  deliveryTime: hhmmSchema,
  categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length),
});
export const quietHoursSchema = z.strictObject({
  enabled: z.boolean(),
  start: hhmmSchema,
  end: hhmmSchema,
});

/** Explicit preferences as stored for a user (every field optional). */
export const userPreferencesSchema = z.strictObject({
  channels: channelPrefsSchema.optional(),
  categories: categoryPrefsSchema.optional(),
  digest: digestPrefsSchema.optional(),
  quietHours: quietHoursSchema.optional(),
  timezone: z.string().optional(),
  locale: z.enum(LOCALES).optional(),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export interface DigestPrefs {
  enabled: boolean;
  frequency: DigestFrequency;
  deliveryTime: string;
  categories: Category[];
}

export interface QuietHoursPrefs {
  enabled: boolean;
  start: string;
  end: string;
}

export type PreferenceSource = 'SYSTEM' | 'SEGMENT' | 'USER';

export interface EffectivePreferences {
  channels: Record<Channel, boolean>;
  categories: Record<Category, { enabled: boolean; channels: Channel[] | null }>;
  digest: DigestPrefs;
  quietHours: QuietHoursPrefs;
  timezone: string;
  locale: Locale;
  /** Which layer supplied each resolved value (for explainability). */
  sources: Record<string, PreferenceSource>;
}
