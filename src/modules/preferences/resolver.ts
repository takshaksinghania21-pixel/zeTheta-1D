import { DateTime } from 'luxon';
import type { NotificationPolicy, SegmentOverride } from '../../config/policy';
import { CATEGORIES, CHANNELS, type Category, type Channel, type Locale } from '../../domain/types';
import type { EventDefinition } from '../taxonomy/taxonomy';
import type { EffectivePreferences, PreferenceSource, UserPreferences } from './types';

export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

/**
 * Resolves layers 1-3 of the preference hierarchy:
 *   1. system defaults (config/notification-policy.yaml)
 *   2. segment overrides (policy.segments[segment])
 *   3. explicit user preferences
 * Later layers win field-by-field. Layer 4 (regulatory overrides) is event
 * specific and is applied by {@link channelsForEvent}.
 */
export function resolvePreferences(
  policy: NotificationPolicy,
  segment: string,
  user: UserPreferences,
  userDefaults: { timezone?: string; locale?: Locale } = {},
): EffectivePreferences {
  const sources: Record<string, PreferenceSource> = {};
  const seg: SegmentOverride = policy.segments[segment] ?? {};

  const channels = {} as Record<Channel, boolean>;
  for (const c of CHANNELS) {
    let value = policy.defaults.channels[c];
    let src: PreferenceSource = 'SYSTEM';
    const segValue = seg.channels?.[c];
    if (segValue !== undefined) {
      value = segValue;
      src = 'SEGMENT';
    }
    const userValue = user.channels?.[c];
    if (userValue !== undefined) {
      value = userValue;
      src = 'USER';
    }
    channels[c] = value;
    sources[`channels.${c}`] = src;
  }

  const categories = {} as Record<Category, { enabled: boolean; channels: Channel[] | null }>;
  for (const cat of CATEGORIES) {
    let enabled = true;
    let catChannels: Channel[] | null = null;
    let src: PreferenceSource = 'SYSTEM';
    const s = seg.categories?.[cat];
    if (s?.enabled !== undefined) {
      enabled = s.enabled;
      src = 'SEGMENT';
    }
    if (s?.channels !== undefined) {
      catChannels = s.channels;
      src = 'SEGMENT';
    }
    const u = user.categories?.[cat];
    if (u?.enabled !== undefined) {
      enabled = u.enabled;
      src = 'USER';
    }
    if (u?.channels !== undefined) {
      catChannels = u.channels;
      src = 'USER';
    }
    categories[cat] = { enabled, channels: catChannels };
    sources[`categories.${cat}`] = src;
  }

  let digest = { ...policy.defaults.digest };
  sources.digest = 'SYSTEM';
  if (seg.digest) {
    digest = { ...digest, ...seg.digest };
    sources.digest = 'SEGMENT';
  }
  if (user.digest) {
    digest = { ...user.digest };
    sources.digest = 'USER';
  }

  let quietHours = { ...policy.quietHours.default };
  sources.quietHours = 'SYSTEM';
  if (user.quietHours) {
    quietHours = { ...user.quietHours };
    sources.quietHours = 'USER';
  }

  const tzCandidate = user.timezone ?? userDefaults.timezone;
  const timezone =
    tzCandidate && isValidTimezone(tzCandidate) ? tzCandidate : policy.defaults.timezone;
  sources.timezone = user.timezone && timezone === user.timezone ? 'USER' : 'SYSTEM';
  const locale = user.locale ?? userDefaults.locale ?? policy.defaults.locale;
  sources.locale = user.locale ? 'USER' : 'SYSTEM';

  return { channels, categories, digest, quietHours, timezone, locale, sources };
}

export interface ChannelSelection {
  /** Channels the user (after hierarchy resolution) wants for this event. */
  preferred: Channel[];
  /** Mandatory channels added by a regulatory override (layer 4). */
  overridden: Channel[];
  /** Channels the user disabled (not delivered, recorded for audit). */
  disabledByUser: Channel[];
  categoryDisabled: boolean;
}

/**
 * Determines candidate channels for an event. A regulatory override can only
 * add channels explicitly listed in the event's `mandatoryChannels`; it never
 * enables channels for promotional events (guarded at taxonomy load too).
 */
export function channelsForEvent(
  def: EventDefinition,
  prefs: EffectivePreferences,
): ChannelSelection {
  const cat = prefs.categories[def.category];
  const base = (cat.channels ?? def.defaultChannels).filter((c) =>
    def.permittedChannels.includes(c),
  );
  const preferred: Channel[] = [];
  const disabledByUser: Channel[] = [];
  for (const c of base) {
    if (cat.enabled && prefs.channels[c]) preferred.push(c);
    else disabledByUser.push(c);
  }
  const overridden: Channel[] = [];
  if (def.regulatoryClass !== 'PROMOTIONAL') {
    for (const m of def.mandatoryChannels) {
      if (!preferred.includes(m)) overridden.push(m);
    }
  }
  return {
    preferred,
    overridden,
    disabledByUser: disabledByUser.filter((c) => !overridden.includes(c)),
    categoryDisabled: !cat.enabled,
  };
}
