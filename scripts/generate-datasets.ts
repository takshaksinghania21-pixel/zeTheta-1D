/**
 * Simulated datasets required by PDF §B4 (p.32), written to data/simulated/:
 *   notification_events.csv (≥ 100 000), user_profiles.csv (≥ 10 000),
 *   delivery_failures.csv (≥ 5 000), user_complaints.csv (≥ 2 000).
 * Distributions are exact (largest-remainder quotas) and generation is
 * deterministic (fixed seed). Usage: `npm run datasets` (override sizes with
 * DATASET_EVENTS, DATASET_USERS, DATASET_FAILURES, DATASET_COMPLAINTS).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PRIORITY_NUMBER } from '../src/api/validators/pdf-contract';
import { EventTaxonomy } from '../src/events/models/taxonomy';
import { SAMPLE_PAYLOADS } from '../src/events/models/fixtures';
import {
  LANGUAGE_WEIGHTS,
  pick,
  prng,
  quota,
  syntheticUser,
} from '../src/database/seeds/synthetic';

type Row = Record<string, string | number | boolean>;

const DAY = 86400000;
const IST_OFFSET = 330 * 60000;
const CATEGORY_WEIGHTS = { TRANSACTION: 40, RISK: 20, SIP: 15, MARKET: 15, REGULATORY: 10 };
const SOURCE: Record<string, string> = {
  TRANSACTION: 'trading_engine',
  RISK: 'margin_engine',
  SIP: 'sip_scheduler',
  MARKET: 'market_data_feed',
  REGULATORY: 'compliance_system',
};
// Minutes after IST midnight: pre-market 07:00–09:15, market 09:15–15:30, post 15:30–20:00.
const WINDOWS = { market: [555, 930], pre: [420, 555], post: [930, 1200] } as const;
const FAILURES = {
  invalid_recipient: 35,
  provider_timeout: 20,
  rate_limited: 15,
  network_error: 10,
  invalid_template: 8,
  dnd_blocked: 7,
  expired_token: 5,
};
const COMPLAINTS = {
  too_many_notifications: 35,
  wrong_time: 25,
  irrelevant_content: 20,
  wrong_channel: 12,
  missing_critical_notification: 8,
};
const PROVIDERS: Record<string, string[]> = {
  sms: ['msg91', 'twilio'],
  email: ['smtp'],
  push: ['fcm'],
  whatsapp: ['whatsapp-cloud'],
  inapp: ['socketio'],
};

export function generateDatasets(
  sizes: { events: number; users: number; failures: number; complaints: number },
  seed = 20261012,
): Record<
  'notification_events' | 'user_profiles' | 'delivery_failures' | 'user_complaints',
  Row[]
> {
  const rand = prng(seed);
  const taxonomy = EventTaxonomy.load();
  const end = Date.UTC(2026, 9, 1); // fixed 30-day window → reproducible files
  const at = (window: readonly [number, number]): string => {
    const day = Math.floor(rand() * 30);
    const minute = window[0] + rand() * (window[1] - window[0]);
    const istMidnight = end - (day + 1) * DAY;
    return new Date(istMidnight + minute * 60000 - IST_OFFSET).toISOString();
  };

  const langs = quota(sizes.users, LANGUAGE_WEIGHTS, rand);
  const dnd = quota(sizes.users, { registered: 30, not_registered: 70 }, rand);
  const users = langs.map((locale, i) => {
    const u = syntheticUser(i + 1, locale, rand);
    const registered = dnd[i] === 'registered';
    return {
      user_id: randomUUIDFrom(rand),
      name: u.name,
      phone: u.phone,
      email: u.email,
      language: locale,
      timezone: 'Asia/Kolkata',
      dnd_status: dnd[i]!,
      // TRAI preference categories 1–7 (1 = Banking/Insurance/Financial products).
      dnd_categories: registered
        ? rand() < 0.5
          ? '1,2,3,4,5,6,7'
          : pick(['2,3', '3,4,6', '1,5', '7'], rand)
        : '',
      account_type: pick(['basic', 'basic', 'basic', 'premium', 'premium', 'HNI'], rand),
      risk_profile: pick(['conservative', 'moderate', 'aggressive'], rand),
      notification_preferences: JSON.stringify({
        channels_off: u.channelsOff,
        disabled_category: u.disabledCategory,
        digest: u.digest ? 'daily' : 'immediate',
      }),
      quiet_hours_start: u.quietHours.enabled ? u.quietHours.start : '',
      quiet_hours_end: u.quietHours.enabled ? u.quietHours.end : '',
      created_at: new Date(end - (30 + Math.floor(rand() * 700)) * DAY).toISOString(),
    };
  });

  const categories = quota(sizes.events, CATEGORY_WEIGHTS, rand);
  const windows = quota(sizes.events, { market: 80, pre: 10, post: 10 }, rand);
  const events = categories.map((category, i) => {
    const def = pick(
      taxonomy.list().filter((d) => d.category === category),
      rand,
    );
    return {
      event_id: `EVT-${String(i + 1).padStart(7, '0')}`,
      event_type: def.code,
      user_id: pick(users, rand).user_id,
      timestamp: at(WINDOWS[windows[i]!]),
      priority: PRIORITY_NUMBER[def.priority],
      source_system: SOURCE[category]!,
      payload: JSON.stringify(SAMPLE_PAYLOADS[def.code] ?? {}),
      channel_preference: pick(def.defaultChannels, rand),
    };
  });

  const failures = quota(sizes.failures, FAILURES, rand).map((code) => {
    const channel =
      code === 'dnd_blocked'
        ? 'sms'
        : code === 'expired_token'
          ? 'push'
          : pick(['sms', 'email', 'push', 'whatsapp'], rand);
    const retries = ['provider_timeout', 'rate_limited', 'network_error'].includes(code)
      ? 1 + Math.floor(rand() * 5)
      : 0;
    return {
      notification_id: randomUUIDFrom(rand),
      channel,
      provider: pick(PROVIDERS[channel]!, rand),
      failure_code: code.toUpperCase(),
      failure_reason: code.replace(/_/g, ' '),
      retry_count: retries,
      final_status:
        code === 'dnd_blocked'
          ? 'DND'
          : retries >= 5
            ? 'DLQ'
            : code === 'invalid_recipient' && channel === 'email'
              ? 'BOUNCED'
              : 'FAILED',
      timestamp: at(WINDOWS.market),
    };
  });

  const complaints = quota(sizes.complaints, COMPLAINTS, rand).map((type, i) => {
    const event = pick(events, rand);
    return {
      complaint_id: `CMP-${String(i + 1).padStart(6, '0')}`,
      user_id: event.user_id,
      complaint_type: type,
      channel: event.channel_preference,
      event_type: event.event_type,
      description: {
        too_many_notifications: 'Receiving too many alerts in a day',
        wrong_time: 'Notification arrived during my quiet hours',
        irrelevant_content: 'This alert is not relevant to my holdings',
        wrong_channel: 'I asked for email, not SMS',
        missing_critical_notification: 'Did not receive the margin call before square-off',
      }[type],
      timestamp: at(WINDOWS.post),
      resolved: rand() < 0.7,
    };
  });

  return {
    notification_events: events,
    user_profiles: users,
    delivery_failures: failures,
    user_complaints: complaints,
  };
}

/** UUID v4 shape from the seeded PRNG (crypto.randomUUID would not be reproducible). */
function randomUUIDFrom(rand: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Math.floor(rand() * 4)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function toCsv(rows: Row[]): string {
  const headers = Object.keys(rows[0] ?? {});
  const cell = (v: unknown): string => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\n') +
    '\n'
  );
}

if (require.main === module) {
  const n = (k: string, d: number) => Number(process.env[k] ?? d);
  const data = generateDatasets({
    events: n('DATASET_EVENTS', 100000),
    users: n('DATASET_USERS', 10000),
    failures: n('DATASET_FAILURES', 5000),
    complaints: n('DATASET_COMPLAINTS', 2000),
  });
  const dir = path.resolve(__dirname, '../data/simulated');
  mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(data)) {
    writeFileSync(path.join(dir, `${name}.csv`), toCsv(rows));
    process.stdout.write(`${name}.csv: ${rows.length} rows\n`);
  }
}
