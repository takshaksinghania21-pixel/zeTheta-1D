import { randomUUID } from 'node:crypto';
import { Container } from '../../src/container';
import { NonRetryableError } from '../../src/utils/errors';
import type { MockProvider } from '../../src/delivery/providers/mock';
import { InMemoryMockBehaviorStore } from '../../src/delivery/providers/mock';
import { InMemoryCircuitStore } from '../../src/delivery/circuit-breaker/circuit-breaker';
import type { DeliveryMessage, NotificationRow } from '../../src/database/models/notification';
import { SAMPLE_PAYLOADS } from '../../src/events/models/fixtures';
import { loadTemplateSources } from '../../src/templates/definitions/source';
import { migrate, truncateAll } from '../helpers/db';
import { testConfig } from '../helpers/env';
import { createUser } from '../helpers/stack';

let c: Container;
let mock: InMemoryMockBehaviorStore;

beforeAll(async () => {
  mock = new InMemoryMockBehaviorStore();
  c = new Container(testConfig(), { mockStore: mock, circuitStore: new InMemoryCircuitStore() });
  await migrate(c.db());
});
beforeEach(async () => {
  await truncateAll(c.db());
  await c.templateRepo().seed(loadTemplateSources());
  await c.registry().sync();
  c.registry().invalidate();
  for (const p of c.registry().providers()) {
    await mock.set(p.name, { mode: 'ok', remaining: null });
    await c.circuit().reset(p.name);
  }
  await c.redis().flushdb(); // Redis DB 6 is reserved for tests
});
afterAll(() => c.close());

const provider = (name: string) => c.registry().get(name) as MockProvider;

async function ingestAndProcess(
  userId: string,
  code = 'TXNX-001',
  payload: Record<string, unknown> = SAMPLE_PAYLOADS[code]!,
): Promise<string> {
  const r = await c
    .ingestion()
    .ingest(
      { eventType: code, userId, occurredAt: new Date().toISOString(), payload },
      'test',
      `corr-${randomUUID()}`,
    );
  await c.processor().process({
    eventId: r.eventId,
    eventType: code,
    userId,
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-test-01',
    schemaVersion: 1,
  });
  return r.eventId;
}

async function channelNotification(eventId: string, channel: string): Promise<NotificationRow> {
  const n = (await c.notifications().byEvent(eventId)).find((x) => x.channel === channel);
  if (!n) throw new Error(`no ${channel} notification`);
  return n;
}

const msg = (n: NotificationRow, retry = n.retry_count): DeliveryMessage => ({
  notificationId: n.id,
  createdAt: new Date(n.created_at).toISOString(),
  retry,
  correlationId: n.correlation_id,
});

describe('event processor (Kafka handler logic)', () => {
  it('creates routed, rendered, queued notifications with decisions and outbox messages', async () => {
    const userId = await createUser(c);
    const eventId = await ingestAndProcess(userId);
    const ns = await c.notifications().byEvent(eventId);
    expect(ns.map((n) => `${n.channel}:${n.state}`).sort()).toEqual([
      'email:QUEUED',
      'inapp:QUEUED',
      'push:QUEUED',
      'sms:QUEUED', // PDF §A2: TXNX-001 → SMS, Push, Email (+ in-app feed)
    ]);
    expect(ns.every((n) => n.content?.body.includes('INFY'))).toBe(true);
    expect((await c.ingestion().getEvent(eventId))?.status).toBe('PROCESSED');
    expect((await c.decisions().list({ eventId, limit: 50 })).length).toBeGreaterThan(0);
    const rabbit = await c.db()('outbox').where({ destination: 'RABBITMQ' });
    expect(rabbit).toHaveLength(4);
  });

  it('edge 6/8: re-processing the same event (redelivery after a crash) creates no duplicates', async () => {
    const userId = await createUser(c);
    const eventId = await ingestAndProcess(userId);
    await c.db()('financial_events').where({ id: eventId }).update({ status: 'RECEIVED' }); // simulate crash before offset commit
    const again = await c.processor().process({
      eventId,
      eventType: 'TXNX-001',
      userId,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-test-02',
      schemaVersion: 1,
    });
    expect(again).toBe('PROCESSED');
    expect(await c.notifications().byEvent(eventId)).toHaveLength(4);
    expect(
      await c.processor().process({
        eventId,
        eventType: 'TXNX-001',
        userId,
        occurredAt: '',
        correlationId: 'x',
        schemaVersion: 1,
      }),
    ).toBe('ALREADY_PROCESSED');
  });

  it('treats unknown event references as non-retryable', async () => {
    await expect(
      c.processor().process({
        eventId: randomUUID(),
        eventType: 'TXNX-001',
        userId: randomUUID(),
        occurredAt: '',
        correlationId: 'x',
        schemaVersion: 1,
      }),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it('fails and dead-letters events whose stored payload no longer validates', async () => {
    const userId = await createUser(c);
    const r = await c.ingestion().ingest(
      {
        eventType: 'TXNX-001',
        userId,
        occurredAt: new Date().toISOString(),
        payload: SAMPLE_PAYLOADS['TXNX-001']!,
      },
      'test',
      'corr-test-03',
    );
    await c
      .db()('financial_events')
      .where({ id: r.eventId })
      .update({ payload: JSON.stringify({ orderId: 'x' }) });
    expect(
      await c.processor().process({
        eventId: r.eventId,
        eventType: 'TXNX-001',
        userId,
        occurredAt: '',
        correlationId: 'x',
        schemaVersion: 1,
      }),
    ).toBe('FAILED');
    const dlq = await c.dlqRepo().list({ source: 'EVENT', limit: 10, offset: 0 });
    expect(dlq.items[0]).toMatchObject({ event_id: r.eventId, reason_code: 'SCHEMA_INVALID' });
  });

  it('edge 2: records DND state for a promotional SMS to a registered number', async () => {
    const userId = await createUser(c);
    await c.dndSource().import({
      source: 'fixture',
      snapshotAt: new Date(),
      importedBy: 't',
      entries: [
        {
          phoneHash: c.users().phoneHash('+919812345678'),
          status: 'FULLY_BLOCKED',
          blockedCategories: [],
        },
      ],
    });
    await c.consents().record({
      userId,
      channel: 'sms',
      purpose: 'PROMOTIONAL',
      status: 'GRANTED',
      source: 'APP',
      recordedBy: 't',
    });
    await c
      .users()
      .updatePreferences(
        userId,
        (p) => ({ ...p, categories: { SIP: { channels: ['sms', 'inapp'] } } }),
        't',
      );
    const eventId = await ingestAndProcess(userId, 'SIPX-004');
    expect((await channelNotification(eventId, 'sms')).state).toBe('DND');
    expect(
      (await c.decisions().list({ eventId, rule: 'DND_FULLY_BLOCKED', limit: 5 })).length,
    ).toBe(1);
  });

  it('escalates a margin call with no reachable mandatory channel to the manual-call queue', async () => {
    const userId = await createUser(c, {
      contacts: [{ channel: 'email', value: 'only-email@example.test' }],
    });
    const eventId = await ingestAndProcess(userId, 'RISK-001');
    const { items } = await c.dlqRepo().list({ source: 'EVENT', limit: 10, offset: 0 });
    const entry = items.find((e) => e.event_id === eventId);
    expect(entry).toMatchObject({ reason_code: 'ESCALATE_MANUAL_CALL', status: 'OPEN' });
    expect(entry?.reason_message).toMatch(/sms, push/);
  });

  it('re-checks DND at dispatch: a number registered after routing is not sent a promotional SMS', async () => {
    const userId = await createUser(c);
    const importDnd = (status: 'FULLY_BLOCKED' | 'NOT_REGISTERED') =>
      c.dndSource().import({
        source: 'fixture',
        snapshotAt: new Date(),
        importedBy: 't',
        entries:
          status === 'NOT_REGISTERED'
            ? []
            : [{ phoneHash: c.users().phoneHash('+919812345678'), status, blockedCategories: [] }],
      });
    await importDnd('NOT_REGISTERED');
    await c.consents().record({
      userId,
      channel: 'sms',
      purpose: 'PROMOTIONAL',
      status: 'GRANTED',
      source: 'APP',
      recordedBy: 't',
    });
    await c
      .users()
      .updatePreferences(
        userId,
        (p) => ({ ...p, categories: { SIP: { channels: ['sms', 'inapp'] } } }),
        't',
      );
    const eventId = await ingestAndProcess(userId, 'SIPX-004');
    const sms = await channelNotification(eventId, 'sms');
    expect(sms.state).toBe('QUEUED'); // allowed at routing time
    // The user registers on DND before the message leaves (backlog, deferral, retry).
    await importDnd('FULLY_BLOCKED');
    await c.dndCache().invalidateAll();
    const sentBefore = provider('mock-sms-primary').sent.length;
    expect(await c.dispatcher().handle(msg(sms))).toBe('ack');
    expect((await c.notifications().require(sms.id)).state).toBe('DND');
    expect(provider('mock-sms-primary').sent.length).toBe(sentBefore);
    const [blocked] = await c.decisions().list({ eventId, rule: 'DND_FULLY_BLOCKED', limit: 5 });
    expect(blocked?.metadata).toMatchObject({ stage: 'DISPATCH' });
  });

  it('self-audits DND: a sent promotional SMS without a dispatch-time clearance is a violation', async () => {
    const userId = await createUser(c);
    await c
      .dndSource()
      .import({ source: 'fixture', snapshotAt: new Date(), importedBy: 't', entries: [] });
    await c.consents().record({
      userId,
      channel: 'sms',
      purpose: 'PROMOTIONAL',
      status: 'GRANTED',
      source: 'APP',
      recordedBy: 't',
    });
    await c
      .users()
      .updatePreferences(
        userId,
        (p) => ({ ...p, categories: { SIP: { channels: ['sms'] } } }),
        't',
      );
    const sms = await channelNotification(await ingestAndProcess(userId, 'SIPX-004'), 'sms');
    await c.dispatcher().handle(msg(sms));
    expect((await c.notifications().require(sms.id)).state).toBe('SENT');
    expect(await c.decisions().dndViolations(new Date())).toBe(0);
    await c
      .db()('policy_decisions')
      .where({ notification_id: sms.id })
      .andWhereRaw(`metadata->>'stage' = 'DISPATCH'`)
      .del();
    expect(await c.decisions().dndViolations(new Date())).toBe(1);
  });

  it('records a dispatch-time DND check for every SMS that is sent (audit proof)', async () => {
    const userId = await createUser(c);
    const sms = await channelNotification(await ingestAndProcess(userId, 'TXNX-003'), 'sms');
    await c.dispatcher().handle(msg(sms));
    expect((await c.notifications().require(sms.id)).state).toBe('SENT');
    const checks = (await c.decisions().list({ userId, limit: 50 })).filter(
      (d) => d.notification_id === sms.id && String(d.rule).startsWith('DND_'),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ rule: 'DND_NOT_APPLICABLE', outcome: 'ALLOW' });
    expect(checks[0]?.metadata).toMatchObject({ stage: 'DISPATCH' });
  });

  it('edge 10: defers push during quiet hours and schedules a durable release job', async () => {
    const userId = await createUser(c);
    const now = new Date();
    const start = `${String(now.getUTCHours()).padStart(2, '0')}:00`;
    const end = `${String((now.getUTCHours() + 8) % 24).padStart(2, '0')}:00`;
    await c
      .users()
      .updatePreferences(userId, (p) => ({ ...p, quietHours: { enabled: true, start, end } }), 't');
    const eventId = await ingestAndProcess(userId);
    const push = await channelNotification(eventId, 'push');
    expect(push.state).toBe('QUIET');
    expect((await channelNotification(eventId, 'email')).state).toBe('QUEUED');
    const job = await c.db()('scheduled_notifications').where({ notification_id: push.id }).first();
    expect(job).toMatchObject({ kind: 'QUIET_RELEASE', status: 'PENDING' });
  });
});

describe('delivery dispatcher', () => {
  it('sends via the primary provider and records the attempt, cost and SENT state', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    expect(await c.dispatcher().handle(msg(push))).toBe('ack');
    const n = await c.notifications().require(push.id);
    expect(n).toMatchObject({ state: 'SENT', provider: 'mock-push', attempt_count: 1 });
    const attempts = await c.notifications().attempts(push.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ status: 'SUCCESS', provider: 'mock-push' });
    expect(provider('mock-push').sent.at(-1)?.recipient).toMatch(/^fcm-token-/);
  });

  it('edge 5: fails over from a failing primary SMS provider to the secondary', async () => {
    const userId = await createUser(c);
    const sms = await channelNotification(await ingestAndProcess(userId, 'TXNX-003'), 'sms');
    await mock.set('mock-sms-primary', { mode: 'fail_transient', remaining: null });
    expect(await c.dispatcher().handle(msg(sms))).toBe('ack');
    const n = await c.notifications().require(sms.id);
    expect(n).toMatchObject({ state: 'SENT', provider: 'mock-sms-secondary' });
    expect(
      (await c.notifications().attempts(sms.id)).map(
        (a) => `${String(a.provider)}:${String(a.status)}`,
      ),
    ).toEqual(['mock-sms-primary:FAILED', 'mock-sms-secondary:SUCCESS']);
  });

  it('edge 4: schedules a retry in the Redis sorted set when every provider is unavailable', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    await c.db()('outbox').del();
    await mock.set('mock-push', { mode: 'fail_transient', remaining: 1 });
    await c.dispatcher().handle(msg(push));
    const n = await c.notifications().require(push.id);
    expect(n).toMatchObject({ state: 'RETRYING', retry_count: 1, last_error_code: 'MOCK_503' });
    expect(await c.db()('outbox').where({ destination: 'RABBITMQ' })).toHaveLength(0);
    const key = `${c.config.RABBITMQ_PREFIX}retry:schedule`;
    const [member, score] = await c.redis().zrange(key, 0, -1, 'WITHSCORES');
    expect(JSON.parse(member ?? '{}')).toMatchObject({ id: push.id, channel: 'push', retry: 1 });
    expect(Number(score)).toBe(new Date(n.next_attempt_at ?? 0).getTime());
    // once due, the retry is released to the channel's delivery queue
    expect(await c.retryScheduler().releaseDue(new Date(Number(score)))).toBe(1);
    const retry = (await c.db()('outbox').where({ destination: 'RABBITMQ' }).first()) as {
      target: string;
      routing_key: string;
      payload: DeliveryMessage;
    };
    expect(retry.target).toBe(c.topology.deliveryExchange);
    expect(retry.routing_key).toBe('push');
    expect(retry.payload.retry).toBe(1);
    // the retried delivery succeeds; the stale original message is ignored
    expect(await c.dispatcher().handle(msg(push, 0))).toBe('ack');
    expect((await c.notifications().require(push.id)).state).toBe('RETRYING');
    await c.dispatcher().handle(msg(push, 1));
    expect((await c.notifications().require(push.id)).state).toBe('SENT');
  });

  it('edge 17: permanent failures are not retried', async () => {
    const userId = await createUser(c);
    const email = await channelNotification(await ingestAndProcess(userId), 'email');
    await c.db()('outbox').del();
    await mock.set('mock-email', { mode: 'fail_permanent', remaining: null });
    await c.dispatcher().handle(msg(email));
    expect((await c.notifications().require(email.id)).state).toBe('FAILED');
    expect(await c.redis().zcard(`${c.config.RABBITMQ_PREFIX}retry:schedule`)).toBe(0);
  });

  it('edge 16: an invalid push token marks the contact invalid and falls back to email', async () => {
    const userId = await createUser(c);
    const eventId = await ingestAndProcess(userId, 'TXNX-003'); // push, sms, in-app; fallback email
    const push = await channelNotification(eventId, 'push');
    await mock.set('mock-push', { mode: 'invalid_recipient', remaining: 1 });
    await c.dispatcher().handle(msg(push));
    expect((await c.notifications().require(push.id)).state).toBe('FAILED');
    const contact = await c
      .db()('user_contacts')
      .where({ user_id: userId, channel: 'push' })
      .first();
    expect(contact).toMatchObject({ status: 'INVALID' });
    const fallback = await channelNotification(eventId, 'email');
    expect(fallback).toMatchObject({ state: 'QUEUED', parent_notification_id: push.id });
    expect((await c.decisions().list({ notificationId: fallback.id, limit: 5 }))[0]).toMatchObject({
      rule: 'FALLBACK_CHANNEL',
    });
  });

  it('edge 18: exhausted retries move the notification to the DLQ with history', async () => {
    const userId = await createUser(c);
    const email = await channelNotification(await ingestAndProcess(userId), 'email');
    await mock.set('mock-email', { mode: 'fail_transient', remaining: null });
    for (let retry = 0; retry <= 5; retry++) {
      await c.dispatcher().handle(msg(email, retry));
      await c.circuit().reset('mock-email'); // isolate retry exhaustion from circuit behaviour
    }
    const n = await c.notifications().require(email.id);
    expect(n.state).toBe('DLQ');
    const entry = (await c.dlqRepo().list({ status: 'OPEN', limit: 5, offset: 0 })).items[0]!;
    expect(entry).toMatchObject({
      notification_id: email.id,
      reason_code: 'RETRIES_EXHAUSTED',
      source: 'DELIVERY',
    });
    expect(entry.retry_history).toHaveLength(6);
    expect(entry.classification).toBe('TRANSIENT'); // automated DLQ classification (Day 9)
    expect(await c.db()('outbox').where({ target: c.topology.dlx })).toHaveLength(1);
  });

  it('edge 19: DLQ manual retry re-queues with a fresh budget; resolution is enforced once', async () => {
    const userId = await createUser(c);
    const email = await channelNotification(await ingestAndProcess(userId), 'email');
    await mock.set('mock-email', { mode: 'fail_transient', remaining: null });
    for (let retry = 0; retry <= 5; retry++) {
      await c.dispatcher().handle(msg(email, retry));
      await c.circuit().reset('mock-email');
    }
    const entry = (await c.dlqRepo().list({ status: 'OPEN', limit: 5, offset: 0 })).items[0]!;
    await mock.set('mock-email', { mode: 'ok', remaining: null });
    const retried = await c.dlq().retry(entry.id, { id: 'op-1', role: 'OPERATOR' }, 'fixed');
    expect(retried.status).toBe('RETRIED');
    const queued = await c.notifications().require(email.id);
    expect(queued).toMatchObject({ state: 'QUEUED', retry_count: 5, retry_budget_start: 5 });
    await c.dispatcher().handle(msg(queued, 5));
    expect((await c.notifications().require(email.id)).state).toBe('SENT');
    await expect(
      c.dlq().resolve(entry.id, 'RESOLVED', { id: 'op-1', role: 'OPERATOR' }, 'again'),
    ).rejects.toThrow(/already RETRIED/);
    expect((await c.audit().list({ targetId: entry.id, limit: 5 }))[0]).toMatchObject({
      action: 'DLQ_RETRY',
      actor_id: 'op-1',
    });
  });

  it('DLQ discard fails the notification and is audited', async () => {
    const userId = await createUser(c);
    const email = await channelNotification(await ingestAndProcess(userId, 'SIPX-002'), 'email');
    await mock.set('mock-email', { mode: 'fail_transient', remaining: null });
    for (let retry = 0; retry <= 5; retry++) {
      // SIPX-002 is HIGH: 5 retries
      await c.dispatcher().handle(msg(email, retry));
      await c.circuit().reset('mock-email');
    }
    const entry = (await c.dlqRepo().list({ status: 'OPEN', limit: 5, offset: 0 })).items[0]!;
    await c
      .dlq()
      .resolve(entry.id, 'DISCARDED', { id: 'admin-1', role: 'ADMIN' }, 'customer closed account');
    expect((await c.notifications().require(email.id)).state).toBe('FAILED');
  });

  it('edge 22: the circuit opens after repeated failures, short-circuits, then recovers', async () => {
    const userId = await createUser(c);
    await mock.set('mock-push', { mode: 'fail_transient', remaining: 5 });
    const ids: NotificationRow[] = [];
    // TXNX-001 is cap-exempt, so all six notifications reach the dispatcher
    for (let i = 0; i < 6; i++)
      ids.push(
        await channelNotification(
          await ingestAndProcess(userId, 'TXNX-001', {
            ...SAMPLE_PAYLOADS['TXNX-001'],
            orderId: `CB-${i}`,
          }),
          'push',
        ),
      );
    for (let i = 0; i < 5; i++) await c.dispatcher().handle(msg(ids[i]!));
    expect((await c.circuit().state('mock-push')).status).toBe('OPEN');
    expect(await c.registry().isChannelAvailable('push')).toBe(false);
    const sentBefore = provider('mock-push').sent.length;
    await c.dispatcher().handle(msg(ids[5]!));
    expect(provider('mock-push').sent.length).toBe(sentBefore); // not called while open
    expect(await c.notifications().attempts(ids[5]!.id)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 1100)); // test policy: 1 s open duration
    const n = await c.notifications().require(ids[5]!.id);
    await c.dispatcher().handle(msg(n));
    expect((await c.notifications().require(ids[5]!.id)).state).toBe('SENT');
    expect((await c.circuit().state('mock-push')).status).toBe('CLOSED');
  });

  it('edge 21: provider rate limits cause failover instead of overloading the provider', async () => {
    const userId = await createUser(c);
    await c.registry().updateConfig('mock-sms-primary', { rate_limit_per_minute: 1 }, 'test');
    const a = await channelNotification(await ingestAndProcess(userId, 'TXNX-003'), 'sms');
    const b = await channelNotification(
      await ingestAndProcess(userId, 'TXNX-003', {
        ...SAMPLE_PAYLOADS['TXNX-003'],
        orderId: 'ORD-2',
      }),
      'sms',
    );
    await c.dispatcher().handle(msg(a));
    await c.dispatcher().handle(msg(b));
    expect((await c.notifications().require(a.id)).provider).toBe('mock-sms-primary');
    expect((await c.notifications().require(b.id)).provider).toBe('mock-sms-secondary');
  });

  it('reserves provider quota for CRITICAL traffic (no priority inversion under bulk load)', async () => {
    const userId = await createUser(c);
    await c.registry().updateConfig('mock-push', { rate_limit_per_minute: 5 }, 'test');
    c.registry().invalidate();
    const pushFor = async (orderId: string) =>
      channelNotification(
        await ingestAndProcess(userId, 'TXNX-003', { ...SAMPLE_PAYLOADS['TXNX-003'], orderId }),
        'push',
      );
    for (let i = 0; i < 4; i++) {
      const n = await pushFor(`BULK-${i}`);
      await c.dispatcher().handle(msg(n));
      expect((await c.notifications().require(n.id)).state).toBe('SENT');
    }
    const fifth = await pushFor('BULK-5');
    await c.dispatcher().handle(msg(fifth));
    expect((await c.notifications().require(fifth.id)).state).toBe('RETRYING'); // 80% used
    const marginCall = await channelNotification(
      await ingestAndProcess(userId, 'RISK-001'),
      'push',
    );
    await c.dispatcher().handle(msg(marginCall));
    expect((await c.notifications().require(marginCall.id)).state).toBe('SENT');
  });

  it('waits for local provider quota without spending the retry budget (no DLQ under overload)', async () => {
    const userId = await createUser(c);
    await c.registry().updateConfig('mock-push', { rate_limit_per_minute: 1 }, 'test');
    c.registry().invalidate();
    const pushFor = async (orderId: string) =>
      channelNotification(
        await ingestAndProcess(userId, 'TXNX-003', { ...SAMPLE_PAYLOADS['TXNX-003'], orderId }),
        'push',
      );
    await c.dispatcher().handle(msg(await pushFor('Q-1'))); // uses the only slot this minute
    const throttled = await pushFor('Q-2');
    for (let retry = 0; retry <= 8; retry++) await c.dispatcher().handle(msg(throttled, retry));
    const n = await c.notifications().require(throttled.id);
    expect(n.state).toBe('RETRYING'); // never DLQ, although HIGH allows only 5 retries
    expect(n.last_error_code).toBe('LOCAL_RATE_LIMIT');
    expect(n.retry_count - n.retry_budget_start).toBe(0);
  });

  it('provider timeouts are classified as transient and fail over', async () => {
    const userId = await createUser(c);
    await c.registry().updateConfig('mock-sms-primary', { timeout_ms: 100 }, 'test');
    await mock.set('mock-sms-primary', { mode: 'timeout', remaining: 1 });
    const sms = await channelNotification(await ingestAndProcess(userId, 'TXNX-003'), 'sms');
    await c.dispatcher().handle(msg(sms));
    const attempts = await c.notifications().attempts(sms.id);
    expect(attempts[0]).toMatchObject({ status: 'FAILED', error_kind: 'TIMEOUT' });
    expect((await c.notifications().require(sms.id)).provider).toBe('mock-sms-secondary');
  });

  it('edge 3: a preference change after routing suppresses the queued notification', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    await c
      .users()
      .updatePreferences(
        userId,
        (p) => ({ ...p, channels: { ...p.channels, push: false } }),
        'user',
      );
    await c.dispatcher().handle(msg(push));
    expect((await c.notifications().require(push.id)).state).toBe('SUPPRESSED');
    expect((await c.decisions().list({ notificationId: push.id, limit: 5 }))[0]).toMatchObject({
      rule: 'PREFERENCE_CHANGED_BEFORE_DISPATCH',
    });
  });

  it('edge 1: a mandatory margin call is still delivered on SMS after the user disables SMS', async () => {
    const userId = await createUser(c);
    await c
      .users()
      .updatePreferences(
        userId,
        (p) => ({ ...p, channels: { ...p.channels, sms: false } }),
        'user',
      );
    const sms = await channelNotification(await ingestAndProcess(userId, 'RISK-001'), 'sms');
    expect(sms.via_override).toBe(true);
    await c.dispatcher().handle(msg(sms));
    expect((await c.notifications().require(sms.id)).state).toBe('SENT');
  });

  it('edge 8: recovers a provider acceptance that was not committed before a crash (no duplicate send)', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    await c.db()('delivery_attempts').insert({
      notification_id: push.id,
      attempt_number: 1,
      provider: 'mock-push',
      channel: 'push',
      status: 'SUCCESS',
      provider_message_id: 'mock-push-recovered',
      cost_micros: 0,
    });
    const sentBefore = provider('mock-push').sent.length;
    await c.dispatcher().handle(msg(push));
    expect(provider('mock-push').sent.length).toBe(sentBefore);
    expect(await c.notifications().require(push.id)).toMatchObject({
      state: 'SENT',
      provider_message_id: 'mock-push-recovered',
    });
  });

  it('edge 8: marks attempts left PENDING by a crashed worker as UNKNOWN and retries', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    await c.db()('delivery_attempts').insert({
      notification_id: push.id,
      attempt_number: 1,
      provider: 'mock-push',
      channel: 'push',
      status: 'PENDING',
    });
    await c.dispatcher().handle(msg(push));
    const attempts = await c.notifications().attempts(push.id);
    expect(attempts.map((a) => a.status)).toEqual(['UNKNOWN', 'SUCCESS']);
  });

  it('acks stale/duplicate messages and requeues when another worker holds the lock', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    await c.redis().set(`lock:notif:${push.id}`, 'other-worker', 'PX', 5000);
    expect(await c.dispatcher().handle(msg(push))).toBe('requeue');
    await c.redis().del(`lock:notif:${push.id}`);
    await c.dispatcher().handle(msg(push));
    const sent = provider('mock-push').sent.length;
    expect(await c.dispatcher().handle(msg(push))).toBe('ack'); // duplicate delivery message
    expect(provider('mock-push').sent.length).toBe(sent);
    expect(await c.dispatcher().handle({ ...msg(push), notificationId: randomUUID() })).toBe(
      'poison',
    );
  });
});

describe('delivery receipts (webhook service)', () => {
  it('edge 7: applies receipts once, ignores duplicates, stale and unknown ones', async () => {
    const userId = await createUser(c);
    const push = await channelNotification(await ingestAndProcess(userId), 'push');
    await c.dispatcher().handle(msg(push));
    const pmid = (await c.notifications().require(push.id)).provider_message_id!;
    const r1 = await c
      .webhooks()
      .apply(
        'mock-push',
        [{ providerEventId: 'e1', providerMessageId: pmid, status: 'DELIVERED' }],
        '{}',
      );
    const r2 = await c
      .webhooks()
      .apply(
        'mock-push',
        [{ providerEventId: 'e1', providerMessageId: pmid, status: 'DELIVERED' }],
        '{}',
      );
    const r3 = await c
      .webhooks()
      .apply(
        'mock-push',
        [{ providerEventId: 'e2', providerMessageId: pmid, status: 'SENT' }],
        '{}',
      );
    const r4 = await c
      .webhooks()
      .apply(
        'mock-push',
        [{ providerEventId: 'e3', providerMessageId: 'nope', status: 'DELIVERED' }],
        '{}',
      );
    expect([r1.APPLIED, r2.DUPLICATE, r3.STALE, r4.UNKNOWN_MESSAGE]).toEqual([1, 1, 1, 1]);
    expect((await c.notifications().require(push.id)).state).toBe('DELIVERED');
  });
});
