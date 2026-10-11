import type { CapRequest, FrequencyCapper } from '../../src/modules/frequency/frequency-capper';

/**
 * Behavioural contract shared by the in-memory and Redis cappers. Each test uses
 * a fresh user id so implementations backed by shared state do not interfere.
 */
export function capperContract(make: () => FrequencyCapper | Promise<FrequencyCapper>): void {
  let n = 0;
  const T0 = new Date('2026-01-15T05:00:00Z').getTime();
  const req = (over: Partial<CapRequest> & { userId: string }): CapRequest => ({
    eventRef: `ev-${++n}`,
    category: 'MARKET',
    cooldownSubject: `S-${n}`,
    channels: ['push'],
    exempt: false,
    now: new Date(T0),
    ...over,
  });
  const uid = () => `cap-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('allows up to the per-channel limit then caps (email: 3/24h)', async () => {
    const c = await make();
    const userId = uid();
    const cats = ['MARKET', 'SIP', 'RISK', 'REGULATORY'] as const;
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(
        await c.checkAndConsume(
          req({ userId, channels: ['email'], category: cats[i]!, now: new Date(T0 + i * 1000) }),
        ),
      );
    }
    expect(results.slice(0, 3).every((r) => r.allowedChannels.includes('email'))).toBe(true);
    expect(results[3]!.blocked).toEqual([{ channel: 'email', scope: 'CHANNEL' }]);
  });

  it('enforces the per-category limit (3 per 60 minutes)', async () => {
    const c = await make();
    const userId = uid();
    for (let i = 0; i < 3; i++)
      expect(
        (await c.checkAndConsume(req({ userId, category: 'SIP', now: new Date(T0 + i) }))).blocked,
      ).toHaveLength(0);
    expect(
      (await c.checkAndConsume(req({ userId, category: 'SIP', now: new Date(T0 + 10) }))).blocked[0]
        ?.scope,
    ).toBe('CATEGORY');
    // other categories are unaffected
    expect(
      (await c.checkAndConsume(req({ userId, category: 'RISK', now: new Date(T0 + 20) }))).blocked,
    ).toHaveLength(0);
  });

  it('frees category budget after the rolling 60-minute window', async () => {
    const c = await make();
    const userId = uid();
    for (let i = 0; i < 3; i++)
      await c.checkAndConsume(req({ userId, category: 'SIP', now: new Date(T0 + i) }));
    expect(
      (await c.checkAndConsume(req({ userId, category: 'SIP', now: new Date(T0 + 3_599_000) })))
        .blocked,
    ).toHaveLength(1);
    expect(
      (await c.checkAndConsume(req({ userId, category: 'SIP', now: new Date(T0 + 3_600_001) })))
        .blocked,
    ).toHaveLength(0);
  });

  it('enforces the global limit of 12 per rolling 24 hours', async () => {
    const c = await make();
    const userId = uid();
    const cats = ['MARKET', 'SIP', 'RISK', 'REGULATORY', 'TRANSACTION'] as const;
    const chans = ['push', 'sms', 'email', 'whatsapp'] as const;
    let allowed = 0;
    for (let i = 0; i < 14; i++) {
      // rotate categories, channels and hours so only the global limit can bind
      const r = await c.checkAndConsume(
        req({
          userId,
          channels: [chans[i % 4]!],
          category: cats[i % 5]!,
          now: new Date(T0 + i * 3_700_000),
        }),
      );
      if (r.blocked.length === 0) allowed++;
      else expect(r.blocked[0]?.scope).toBe('GLOBAL');
    }
    expect(allowed).toBe(12);
  });

  it('enforces SMS 5/24h and push 8/24h', async () => {
    const c = await make();
    const userId = uid();
    const cats = ['MARKET', 'SIP', 'RISK', 'REGULATORY', 'TRANSACTION'] as const;
    let sms = 0;
    let push = 0;
    for (let i = 0; i < 10; i++) {
      const r = await c.checkAndConsume(
        req({
          userId,
          channels: ['sms', 'push'],
          category: cats[i % 5]!,
          now: new Date(T0 + i * 3_700_000),
        }),
      );
      if (r.allowedChannels.includes('sms')) sms++;
      if (r.allowedChannels.includes('push')) push++;
    }
    expect(sms).toBe(5);
    expect(push).toBe(8);
  });

  it('applies a 15-minute cooldown for the same event subject', async () => {
    const c = await make();
    const userId = uid();
    expect(
      (
        await c.checkAndConsume(
          req({ userId, cooldownSubject: 'MKTX-001:SBIN', now: new Date(T0) }),
        )
      ).blocked,
    ).toHaveLength(0);
    expect(
      (
        await c.checkAndConsume(
          req({ userId, cooldownSubject: 'MKTX-001:SBIN', now: new Date(T0 + 899_000) }),
        )
      ).blocked[0]?.scope,
    ).toBe('COOLDOWN');
    expect(
      (
        await c.checkAndConsume(
          req({ userId, cooldownSubject: 'MKTX-001:INFY', now: new Date(T0 + 1000) }),
        )
      ).blocked,
    ).toHaveLength(0);
    expect(
      (
        await c.checkAndConsume(
          req({
            userId,
            cooldownSubject: 'MKTX-001:SBIN',
            category: 'RISK',
            now: new Date(T0 + 900_001),
          }),
        )
      ).blocked,
    ).toHaveLength(0);
  });

  it('never blocks exempt events but still counts them', async () => {
    const c = await make();
    const userId = uid();
    for (let i = 0; i < 6; i++) {
      const r = await c.checkAndConsume(
        req({
          userId,
          channels: ['email'],
          exempt: true,
          cooldownSubject: 'RISK-001',
          category: 'RISK',
          now: new Date(T0 + i),
        }),
      );
      expect(r.allowedChannels).toEqual(['email']);
    }
    const r = await c.checkAndConsume(
      req({ userId, channels: ['email'], category: 'SIP', now: new Date(T0 + 10) }),
    );
    expect(r.blocked[0]?.scope).toBe('CHANNEL');
  });

  it('blocks only the exhausted channel when others still have budget', async () => {
    const c = await make();
    const userId = uid();
    const cats = ['MARKET', 'SIP', 'RISK'] as const;
    for (let i = 0; i < 3; i++)
      await c.checkAndConsume(
        req({ userId, channels: ['email'], category: cats[i]!, now: new Date(T0 + i) }),
      );
    const r = await c.checkAndConsume(
      req({ userId, channels: ['email', 'push'], category: 'REGULATORY', now: new Date(T0 + 10) }),
    );
    expect(r.allowedChannels).toEqual(['push']);
    expect(r.blocked).toEqual([{ channel: 'email', scope: 'CHANNEL' }]);
  });

  it('does not consume budget for blocked events', async () => {
    const c = await make();
    const userId = uid();
    await c.checkAndConsume(req({ userId, cooldownSubject: 'X', now: new Date(T0) }));
    await c.checkAndConsume(req({ userId, cooldownSubject: 'X', now: new Date(T0 + 1) })); // cooldown-blocked
    const usage = await c.usage(userId, new Date(T0 + 2));
    expect(usage.global).toBe(1);
    expect(usage.push).toBe(1);
  });

  it('is idempotent when the same event is re-evaluated (consumer redelivery)', async () => {
    const c = await make();
    const userId = uid();
    for (let i = 0; i < 2; i++)
      await c.checkAndConsume(req({ userId, category: 'SIP', now: new Date(T0 + i) }));
    const third = req({ userId, category: 'SIP', now: new Date(T0 + 5) });
    expect((await c.checkAndConsume(third)).allowedChannels).toEqual(['push']);
    // redelivery of the 3rd event must not be capped by its own earlier consumption
    expect((await c.checkAndConsume({ ...third, now: new Date(T0 + 50) })).allowedChannels).toEqual(
      ['push'],
    );
    expect((await c.usage(userId, new Date(T0 + 60))).global).toBe(3);
  });

  it('dry runs report the outcome without consuming budget', async () => {
    const c = await make();
    const userId = uid();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await c.checkAndConsume(
            req({ userId, category: 'SIP', dryRun: true, now: new Date(T0 + i) }),
          )
        ).allowedChannels,
      ).toEqual(['push']);
    }
    expect((await c.usage(userId, new Date(T0 + 10))).global).toBe(0);
  });

  it('tracks cap hits for weekly digest suggestions within the window', async () => {
    const c = await make();
    const userId = uid();
    for (let i = 0; i < 4; i++) await c.recordCapHit(userId, `h${i}`, new Date(T0 + i));
    expect(await c.recordCapHit(userId, 'h5', new Date(T0 + 10))).toBe(5);
    expect(await c.recordCapHit(userId, 'h6', new Date(T0 + 8 * 86_400_000))).toBe(1);
  });
}
