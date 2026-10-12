import { ManualClock } from '../../src/common/clock';
import { Container } from '../../src/container';
import { InMemoryMockBehaviorStore } from '../../src/infrastructure/providers/mock';
import { InMemoryCircuitStore } from '../../src/modules/delivery/circuit-breaker';
import { SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import { loadTemplateSources } from '../../src/modules/templates/source';
import { migrate, truncateAll } from '../helpers/db';
import { testConfig } from '../helpers/env';
import { createUser } from '../helpers/stack';

// 22:30 IST on 2026-01-15 — inside the default 21:00–08:00 window in Asia/Kolkata.
const NIGHT = '2026-01-15T17:00:00.000Z';
const MORNING_RELEASE = '2026-01-16T02:30:00.000Z';

let c: Container;
let clock: ManualClock;

beforeAll(async () => {
  clock = new ManualClock(NIGHT);
  c = new Container(testConfig(), {
    clock,
    mockStore: new InMemoryMockBehaviorStore(),
    circuitStore: new InMemoryCircuitStore(),
  });
  await migrate(c.db());
});
beforeEach(async () => {
  clock.set(NIGHT);
  await truncateAll(c.db());
  await c.templateRepo().seed(loadTemplateSources());
  await c.registry().sync();
  await c.redis().flushdb(); // Redis DB 6 is reserved for tests
});
afterAll(() => c.close());

async function nightUser(): Promise<string> {
  const id = await createUser(c, { timezone: 'Asia/Kolkata' });
  await c
    .users()
    .updatePreferences(
      id,
      (p) => ({ ...p, quietHours: { enabled: true, start: '21:00', end: '08:00' } }),
      't',
    );
  return id;
}

async function process(
  userId: string,
  code: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const r = await c
    .ingestion()
    .ingest(
      { eventType: code, userId, occurredAt: clock.now().toISOString(), payload },
      'test',
      `corr-${Math.random()}`,
    );
  await c.processor().process({
    eventId: r.eventId,
    eventType: code,
    userId,
    occurredAt: '',
    correlationId: 'corr-sched-01',
    schemaVersion: 1,
  });
  return r.eventId;
}

describe('quiet hours scheduling (durable, restart-safe)', () => {
  it('releases a deferred notification at the end of quiet hours in the user timezone', async () => {
    const userId = await nightUser();
    const eventId = await process(userId, 'TXNX-003', SAMPLE_PAYLOADS['TXNX-003']!);
    const push = (await c.notifications().byEvent(eventId)).find((n) => n.channel === 'push')!;
    expect(push.state).toBe('QUIET');
    expect(new Date(push.next_attempt_at!).toISOString()).toBe(MORNING_RELEASE);
    expect(await c.scheduler().runDue()).toBe(0); // not due yet
    clock.set(MORNING_RELEASE);
    expect(await c.scheduler().runDue()).toBe(2); // push + sms jobs
    expect((await c.notifications().require(push.id)).state).toBe('QUEUED');
    const job = await c.db()('scheduled_notifications').where({ notification_id: push.id }).first();
    expect(job.status).toBe('DONE');
  });

  it('folds more than five deferred notifications into one morning digest', async () => {
    const userId = await nightUser();
    for (let i = 0; i < 6; i++)
      await process(userId, 'TXNX-003', { ...SAMPLE_PAYLOADS['TXNX-003'], orderId: `N-${i}` });
    clock.set(MORNING_RELEASE);
    await c.scheduler().runDue();
    const digests = await c.db()('notifications').where({ user_id: userId, is_digest: true });
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      state: 'QUEUED',
      event_type: 'SYS-DIGEST',
      channel: 'push',
    });
    expect(digests[0].content.title).toContain('6');
    const folded = await c.db()('notifications').where({ user_id: userId, state: 'DIGESTED' });
    expect(folded.length).toBe(12); // 6 events × (push + sms)
    expect(folded.every((n: { digest_id: string }) => n.digest_id === digests[0].id)).toBe(true);
  });

  it('re-applies frequency caps when releasing deferred notifications', async () => {
    const userId = await nightUser();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push(
        await process(userId, 'MKTX-001', {
          ...SAMPLE_PAYLOADS['MKTX-001'],
          alertId: `Q${i}`,
          symbol: `S${i}`,
        }),
      );
    clock.set(MORNING_RELEASE);
    await c.scheduler().runDue();
    const states = await Promise.all(
      ids.map(
        async (id) =>
          (await c.notifications().byEvent(id)).find((n) => n.channel === 'push')!.state,
      ),
    );
    expect(states.filter((s) => s === 'QUEUED')).toHaveLength(3); // category cap: 3 per hour
    expect(states.filter((s) => s === 'CAPPED')).toHaveLength(1);
    // MKTX-001 defers push + SMS: both channels of one event count once against the caps.
    const sms = await Promise.all(
      ids.map(
        async (id) => (await c.notifications().byEvent(id)).find((n) => n.channel === 'sms')!.state,
      ),
    );
    expect(sms).toEqual(states);
  });

  it('survives a scheduler crash: stuck PROCESSING jobs are reclaimed', async () => {
    const userId = await nightUser();
    await process(userId, 'TXNX-003', SAMPLE_PAYLOADS['TXNX-003']!);
    clock.set(MORNING_RELEASE);
    // simulate a scheduler that claimed jobs and died
    await c
      .db()('scheduled_notifications')
      .update({
        status: 'PROCESSING',
        locked_by: 'dead-host',
        locked_at: new Date(clock.now().getTime() - 3600000),
      });
    expect(await c.scheduler().runDue()).toBe(0);
    const swept = await c.scheduler().sweep();
    expect(swept.jobs).toBe(2);
    expect(await c.scheduler().runDue()).toBe(2);
  });

  it('edge 24/25: scheduling across midnight and DST boundaries', async () => {
    const userId = await createUser(c, { timezone: 'America/New_York' });
    await c
      .users()
      .updatePreferences(
        userId,
        (p) => ({ ...p, quietHours: { enabled: true, start: '22:00', end: '06:00' } }),
        't',
      );
    clock.set('2026-03-08T05:30:00Z'); // 00:30 EST, the night clocks spring forward
    const eventId = await process(userId, 'TXNX-003', SAMPLE_PAYLOADS['TXNX-003']!);
    const push = (await c.notifications().byEvent(eventId)).find((n) => n.channel === 'push')!;
    expect(push.state).toBe('QUIET');
    // 06:00 EDT = 10:00Z (only 4.5 real hours later because of the DST jump)
    expect(new Date(push.next_attempt_at!).toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  it('edge 11: critical events bypass quiet hours and the bypass is auditable', async () => {
    const userId = await nightUser();
    const eventId = await process(userId, 'RISK-002', SAMPLE_PAYLOADS['RISK-002']!);
    const sms = (await c.notifications().byEvent(eventId)).find((n) => n.channel === 'sms')!;
    expect(sms.state).toBe('QUEUED');
    const decisions = await c.decisions().list({ eventId, rule: 'QUIET_HOURS_BYPASS', limit: 10 });
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0]).toMatchObject({ outcome: 'BYPASS' });
    const history = await c.notifications().history(sms.id);
    expect(history.find((h) => h.to_state === 'QUEUED')).toMatchObject({
      reason: 'QUIET_HOURS_BYPASS',
    });
  });
});

describe('preference digests and suggestions', () => {
  it('batches low-priority events into a scheduled digest', async () => {
    const userId = await createUser(c);
    await c.users().updatePreferences(
      userId,
      (p) => ({
        ...p,
        categories: { MARKET: { channels: ['push', 'inapp'] } },
        digest: {
          enabled: true,
          frequency: 'DAILY',
          deliveryTime: '18:00',
          categories: ['MARKET'],
        },
      }),
      't',
    );
    // MKTX-003 is PROMOTIONAL (Engagement): push needs explicit opt-in.
    await c.consents().record({
      userId,
      channel: 'push',
      purpose: 'PROMOTIONAL',
      status: 'GRANTED',
      source: 'APP',
      recordedBy: 't',
    });
    clock.set('2026-01-15T09:00:00Z');
    await process(userId, 'MKTX-003', SAMPLE_PAYLOADS['MKTX-003']!);
    await process(userId, 'MKTX-003', { ...SAMPLE_PAYLOADS['MKTX-003'], session: 'OPEN' });
    const digested = await c.db()('notifications').where({ user_id: userId, state: 'DIGESTED' });
    expect(digested).toHaveLength(2);
    const jobs = await c.db()('scheduled_notifications').where({ user_id: userId, kind: 'DIGEST' });
    expect(jobs).toHaveLength(1); // one job per user per digest time
    clock.set('2026-01-15T18:00:00Z');
    await c.scheduler().runDue();
    const digest = await c
      .db()('notifications')
      .where({ user_id: userId, is_digest: true })
      .first();
    expect(digest).toMatchObject({ channel: 'email', state: 'QUEUED' });
  });

  it('suggests a digest when the user averages more than 8 notifications/day over 7 days', async () => {
    const userId = await createUser(c);
    const notify = async (day: number, i: number) => {
      clock.set(new Date(Date.UTC(2026, 0, 10 + day, 6, i)).toISOString());
      await process(userId, 'TXNX-003', {
        ...SAMPLE_PAYLOADS['TXNX-003'],
        orderId: `D${day}-${i}`,
      });
    };
    for (let day = 0; day < 7; day++) for (let i = 0; i < 8; i++) await notify(day, i); // exactly 8/day
    expect(await c.db()('digest_suggestions').where({ user_id: userId }).first()).toBeUndefined();
    await notify(6, 30); // 57 in 7 days → average above 8/day
    const s = await c.db()('digest_suggestions').where({ user_id: userId }).first();
    expect(s).toMatchObject({ notifications_in_window: 57, suggested_frequency: 'WEEKLY' });
  });
});

describe('restart recovery sweeper', () => {
  it('re-enqueues notifications whose delivery message may have been lost', async () => {
    const userId = await createUser(c);
    clock.set('2026-01-15T09:00:00Z');
    const eventId = await process(userId, 'TXNX-001', SAMPLE_PAYLOADS['TXNX-001']!);
    await c.db()('outbox').del();
    clock.set('2026-01-15T10:00:00Z');
    const r = await c.scheduler().sweep();
    expect(r.notifications).toBe(4);
    const outbox = await c.db()('outbox').where({ destination: 'RABBITMQ' });
    expect(outbox.map((o: { routing_key: string }) => o.routing_key).sort()).toEqual([
      'email',
      'inapp',
      'push',
      'sms',
    ]);
    expect((await c.notifications().byEvent(eventId)).every((n) => n.state === 'QUEUED')).toBe(
      true,
    );
  });
});
