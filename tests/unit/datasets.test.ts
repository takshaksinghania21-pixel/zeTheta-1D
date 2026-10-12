import { generateDatasets } from '../../scripts/generate-datasets';

const share = (rows: Record<string, unknown>[], key: string) => {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[key])] = (out[String(r[key])] ?? 0) + 1;
  return out;
};

describe('simulated datasets (PDF §B4)', () => {
  const d = generateDatasets({ events: 1000, users: 500, failures: 200, complaints: 100 });

  it('matches the PDF distributions exactly', () => {
    const prefix = share(
      d.notification_events.map((e) => ({ c: String(e.event_type).slice(0, 4) })),
      'c',
    );
    expect(prefix).toEqual({ TXNX: 400, RISK: 200, SIPX: 150, MKTX: 150, REGX: 100 });
    expect(share(d.user_profiles, 'language')).toEqual({
      en: 100,
      hi: 210,
      mr: 90,
      ta: 60,
      te: 40,
    });
    expect(share(d.user_profiles, 'dnd_status')).toEqual({ registered: 150, not_registered: 350 });
    expect(share(d.delivery_failures, 'failure_code')).toEqual({
      INVALID_RECIPIENT: 70,
      PROVIDER_TIMEOUT: 40,
      RATE_LIMITED: 30,
      NETWORK_ERROR: 20,
      INVALID_TEMPLATE: 16,
      DND_BLOCKED: 14,
      EXPIRED_TOKEN: 10,
    });
    expect(share(d.user_complaints, 'complaint_type')).toEqual({
      too_many_notifications: 35,
      wrong_time: 25,
      irrelevant_content: 20,
      wrong_channel: 12,
      missing_critical_notification: 8,
    });
  });

  it('puts 80% of events in market hours (09:15–15:30 IST)', () => {
    const inMarket = d.notification_events.filter((e) => {
      const t = new Date(String(e.timestamp));
      const ist = (t.getUTCHours() * 60 + t.getUTCMinutes() + 330) % 1440;
      return ist >= 555 && ist < 930;
    }).length;
    expect(inMarket).toBe(800);
  });

  it('is deterministic and uses only synthetic contact data', () => {
    const again = generateDatasets({ events: 1000, users: 500, failures: 200, complaints: 100 });
    expect(again.user_profiles[7]).toEqual(d.user_profiles[7]);
    expect(d.user_profiles.every((u) => /^\+9190000\d{5}$/.test(String(u.phone)))).toBe(true);
    expect(d.user_profiles.every((u) => String(u.email).endsWith('@example.test'))).toBe(true);
  });
});
