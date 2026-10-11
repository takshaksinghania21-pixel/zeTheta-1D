import { createHarness, ALL_CONTACTS } from '../helpers/routing';

const DAY = '2026-01-15T06:00:00.000Z'; // 11:30 IST
const NIGHT = '2026-01-15T17:00:00.000Z'; // 22:30 IST

describe('routing engine', () => {
  it('routes a transaction confirmation to the default channels', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(h.input('TXNX-001'));
    expect(plan.plans.map((p) => [p.channel, p.action])).toEqual([
      ['push', 'QUEUE'],
      ['email', 'QUEUE'],
      ['inapp', 'QUEUE'],
    ]);
  });

  it('edge 1: delivers a mandatory margin call on SMS even when the user disabled SMS', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(
      h.input('RISK-001', { prefs: { channels: { sms: false, email: false } } }),
    );
    const sms = plan.plans.find((p) => p.channel === 'sms');
    expect(sms).toMatchObject({ action: 'QUEUE', viaOverride: true });
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'sms',
          rule: 'REGULATORY_MANDATORY_CHANNEL',
          outcome: 'OVERRIDE',
        }),
      ]),
    );
  });

  it('regulatory override does not bypass a WhatsApp opt-in or an explicit consent revocation', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(
      h.input('RISK-001', {
        prefs: { channels: { sms: false } },
        consents: [
          {
            channel: 'sms',
            purpose: 'TRANSACTIONAL',
            status: 'REVOKED',
            recordedAt: new Date(DAY),
            source: 'test',
          },
        ],
      }),
    );
    expect(plan.plans.find((p) => p.channel === 'sms')?.action).toBe('SUPPRESS');
    expect(plan.plans.find((p) => p.channel === 'email')?.action).toBe('QUEUE');
  });

  it('flags mandatory events that cannot reach any mandatory channel', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(
      h.input('RISK-002', { contacts: [{ channel: 'push', status: 'ACTIVE' }] }),
    );
    expect(plan.decisions.some((d) => d.rule === 'MANDATORY_UNDELIVERABLE')).toBe(true);
  });

  it('edge 2: blocks a promotional SMS to a DND-registered recipient', async () => {
    const h = createHarness(DAY);
    h.dndSource.entries.set('phone-1', {
      status: 'FULLY_BLOCKED',
      blockedCategories: [],
      registryUpdatedAt: h.clock.now(),
      source: 'fixture',
    });
    const consents = (['sms', 'push', 'email'] as const).map((channel) => ({
      channel,
      purpose: 'PROMOTIONAL' as const,
      status: 'GRANTED' as const,
      recordedAt: new Date(DAY),
      source: 'test',
    }));
    const plan = await h.engine.route(
      h.input('SIPX-004', {
        prefs: { categories: { SIP: { channels: ['sms', 'push'] } } },
        consents,
      }),
    );
    expect(plan.plans.find((p) => p.channel === 'sms')).toMatchObject({
      action: 'DND',
      reason: 'DND_FULLY_BLOCKED',
    });
    expect(plan.plans.find((p) => p.channel === 'push')?.action).toBe('QUEUE');
  });

  it('does not apply DND to transactional SMS', async () => {
    const h = createHarness(DAY);
    h.dndSource.entries.set('phone-1', {
      status: 'FULLY_BLOCKED',
      blockedCategories: [],
      registryUpdatedAt: h.clock.now(),
      source: 'fixture',
    });
    const plan = await h.engine.route(h.input('TXNX-003'));
    expect(plan.plans.find((p) => p.channel === 'sms')?.action).toBe('QUEUE');
  });

  it('suppresses promotional messages without consent and does not fall back', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(h.input('SIPX-004'));
    expect(
      plan.plans.filter((p) => p.channel !== 'inapp').every((p) => p.action === 'SUPPRESS'),
    ).toBe(true);
    expect(plan.plans.find((p) => p.channel === 'inapp')?.action).toBe('QUEUE');
    expect(plan.decisions.some((d) => d.rule === 'FALLBACK_CHANNEL')).toBe(false);
  });

  it('edge 10: defers non-critical push/SMS during quiet hours but keeps email and in-app', async () => {
    const h = createHarness(NIGHT);
    const plan = await h.engine.route(h.input('TXNX-003')); // push, sms, inapp
    expect(plan.plans.find((p) => p.channel === 'push')).toMatchObject({ action: 'DEFER' });
    expect(plan.plans.find((p) => p.channel === 'push')?.releaseAt?.toISOString()).toBe(
      '2026-01-16T02:30:00.000Z',
    );
    expect(plan.plans.find((p) => p.channel === 'sms')?.action).toBe('DEFER');
    expect(plan.plans.find((p) => p.channel === 'inapp')?.action).toBe('QUEUE');
  });

  it('edge 11: critical events bypass quiet hours with an auditable decision', async () => {
    const h = createHarness(NIGHT);
    const plan = await h.engine.route(h.input('RISK-001'));
    expect(plan.plans.find((p) => p.channel === 'sms')).toMatchObject({
      action: 'QUEUE',
      quietBypassed: true,
    });
    const bypass = plan.decisions.filter((d) => d.rule === 'QUIET_HOURS_BYPASS');
    expect(bypass.length).toBeGreaterThan(0);
    expect(bypass[0]).toMatchObject({
      outcome: 'BYPASS',
      metadata: expect.objectContaining({ localTime: '22:30', timezone: 'Asia/Kolkata' }),
    });
  });

  it('uses the user timezone for quiet hours', async () => {
    const h = createHarness(NIGHT); // 22:30 IST, 12:30 New York
    const plan = await h.engine.route(
      h.input('TXNX-003', { prefs: { timezone: 'America/New_York' } }),
    );
    expect(plan.plans.find((p) => p.channel === 'push')?.action).toBe('QUEUE');
  });

  it('honours a user-defined quiet window', async () => {
    const h = createHarness(DAY); // 11:30 IST
    const plan = await h.engine.route(
      h.input('TXNX-003', {
        prefs: { quietHours: { enabled: true, start: '10:00', end: '17:00' } },
      }),
    );
    expect(plan.plans.find((p) => p.channel === 'push')?.action).toBe('DEFER');
  });

  it('caps notifications and records cap decisions', async () => {
    const h = createHarness(DAY);
    await h.engine.route(h.input('MKTX-001', { payload: { symbol: 'SBIN' } }));
    await h.engine.route(h.input('MKTX-001', { payload: { symbol: 'INFY' } }));
    await h.engine.route(h.input('MKTX-002', { payload: { symbol: 'TCS' } }));
    const plan = await h.engine.route(h.input('MKTX-002', { payload: { symbol: 'ITC' } }));
    expect(plan.capHit).toBe(true);
    expect(plan.plans.find((p) => p.channel === 'push')).toMatchObject({
      action: 'CAP',
      reason: 'FREQUENCY_CAP_CATEGORY',
    });
    expect(plan.plans.find((p) => p.channel === 'inapp')?.action).toBe('QUEUE');
  });

  it('never caps exempt critical events', async () => {
    const h = createHarness(DAY);
    for (let i = 0; i < 15; i++) {
      const plan = await h.engine.route(
        h.input('RISK-001', { payload: { marginCallId: `M${i}` } }),
      );
      expect(plan.plans.some((p) => p.action === 'CAP')).toBe(false);
    }
  });

  it('falls back when the primary channel has no contact', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(
      h.input('TXNX-001', { contacts: ALL_CONTACTS.filter((c) => c.channel !== 'push') }),
    );
    expect(plan.plans.find((p) => p.channel === 'sms')).toMatchObject({
      action: 'QUEUE',
      fallbackFor: 'push',
    });
    expect(plan.decisions.some((d) => d.rule === 'NO_CONTACT' && d.channel === 'push')).toBe(true);
  });

  it('edge 16: falls back from an invalid push token', async () => {
    const h = createHarness(DAY);
    const contacts = ALL_CONTACTS.map((c) =>
      c.channel === 'push' ? { ...c, status: 'INVALID' as const } : c,
    );
    const plan = await h.engine.route(h.input('TXNX-001', { contacts }));
    expect(plan.decisions.some((d) => d.rule === 'CONTACT_INVALID')).toBe(true);
    expect(plan.plans.find((p) => p.channel === 'sms')?.fallbackFor).toBe('push');
  });

  it('falls back when no healthy provider exists for a channel', async () => {
    const h = createHarness(DAY);
    h.unavailable.add('push');
    const plan = await h.engine.route(h.input('TXNX-001'));
    expect(plan.plans.find((p) => p.channel === 'push')).toBeUndefined();
    expect(plan.plans.find((p) => p.channel === 'sms')?.fallbackFor).toBe('push');
  });

  it('keeps the channel queued for retry when no fallback is possible', async () => {
    const h = createHarness(DAY);
    h.unavailable.add('push');
    const plan = await h.engine.route(h.input('MKTX-002')); // push, inapp; no fallback
    expect(plan.plans.find((p) => p.channel === 'push')?.action).toBe('QUEUE');
  });

  it('does not fall back to a channel the user disabled', async () => {
    const h = createHarness(DAY);
    h.unavailable.add('push');
    const plan = await h.engine.route(h.input('TXNX-001', { prefs: { channels: { sms: false } } }));
    expect(plan.plans.find((p) => p.channel === 'sms')).toBeUndefined();
  });

  it('routes away from SMS when the daily budget is exhausted, except for high priority', async () => {
    const h = createHarness(DAY);
    await h.budget.add('sms', h.policy.costs.dailyBudgetMicros.sms!, h.clock.now());
    const low = await h.engine.route(
      h.input('SIPX-001', { prefs: { categories: { SIP: { channels: ['sms', 'inapp'] } } } }),
    );
    expect(low.decisions.some((d) => d.rule === 'BUDGET_EXHAUSTED')).toBe(true);
    expect(low.plans.find((p) => p.channel === 'sms')).toBeUndefined();
    const high = await h.engine.route(h.input('TXNX-003'));
    expect(high.plans.find((p) => p.channel === 'sms')?.action).toBe('QUEUE');
  });

  it('batches low-priority market events into the user digest', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(
      h.input('MKTX-003', {
        prefs: {
          categories: { MARKET: { channels: ['push', 'inapp'] } },
          digest: {
            enabled: true,
            frequency: 'DAILY',
            deliveryTime: '18:00',
            categories: ['MARKET'],
          },
        },
      }),
    );
    expect(plan.plans.find((p) => p.channel === 'push')).toMatchObject({ action: 'DIGEST' });
    expect(plan.plans.find((p) => p.channel === 'push')?.releaseAt?.toISOString()).toBe(
      '2026-01-15T12:30:00.000Z',
    );
    expect(plan.plans.find((p) => p.channel === 'inapp')?.action).toBe('QUEUE');
  });

  it('records preference blocks for audit', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(
      h.input('TXNX-001', { prefs: { channels: { email: false } } }),
    );
    expect(plan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: 'email', rule: 'PREFERENCE_CHANNEL_DISABLED' }),
      ]),
    );
  });

  it('routes nothing for inactive users', async () => {
    const h = createHarness(DAY);
    const plan = await h.engine.route(h.input('TXNX-001', { status: 'ANONYMIZED' }));
    expect(plan.plans).toHaveLength(0);
    expect(plan.decisions[0]?.rule).toBe('USER_INACTIVE');
  });

  it('is deterministic for identical inputs', async () => {
    const a = createHarness(DAY);
    const b = createHarness(DAY);
    const pa = await a.engine.route(
      a.input('RISK-001', { eventId: 'same', prefs: { channels: { sms: false } } }),
    );
    const pb = await b.engine.route(
      b.input('RISK-001', { eventId: 'same', prefs: { channels: { sms: false } } }),
    );
    expect(pa).toEqual(pb);
  });
});
