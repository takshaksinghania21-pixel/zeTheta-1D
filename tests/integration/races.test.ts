import { randomUUID } from 'node:crypto';
import { Container } from '../../src/container';
import { InMemoryMockBehaviorStore } from '../../src/delivery/providers/mock';
import { InMemoryCircuitStore } from '../../src/delivery/circuit-breaker/circuit-breaker';
import type { DeliveryProvider, DeliveryRequest } from '../../src/delivery/providers/provider';
import { buildProviders } from '../../src/delivery/providers/registry';
import type { NotificationRow } from '../../src/database/models/notification';
import { SAMPLE_PAYLOADS } from '../../src/events/models/fixtures';
import { loadTemplateSources } from '../../src/templates/definitions/source';
import { loadPolicy } from '../../src/config/policy';
import { migrate, truncateAll } from '../helpers/db';
import { testConfig } from '../helpers/env';
import { createUser } from '../helpers/stack';

/**
 * Regression tests for races found during e2e verification: a client (or a
 * provider receipt) can be faster than the dispatcher's SENT commit.
 */
let c: Container;
const mock = new InMemoryMockBehaviorStore();
let fastClient = false;

beforeAll(async () => {
  const config = testConfig();
  const base = buildProviders(config, loadPolicy(), {
    mockStore: mock,
    emitter: { to: () => ({ emit: () => true }) } as never,
  });
  const ackingInApp: DeliveryProvider = {
    name: 'socketio',
    channel: 'inapp',
    // Simulates a client that receives the socket event and acks immediately,
    // before the dispatcher has committed the SENT transition.
    send: async (req: DeliveryRequest) => {
      if (fastClient)
        await c
          .notificationService()
          .acknowledge(req.userId, req.notificationId, 'corr-fast-client');
      return { providerMessageId: req.notificationId, status: 'ACCEPTED', costMicros: 0 };
    },
    getStatus: (id) => Promise.resolve({ providerMessageId: id, status: 'UNKNOWN' }),
    validateRecipient: () => ({ valid: true }),
    getQuota: () =>
      Promise.resolve({
        limitPerMinute: null,
        remaining: null,
        resetAt: null,
        source: 'unlimited',
      }),
  };
  c = new Container(config, {
    mockStore: mock,
    circuitStore: new InMemoryCircuitStore(),
    providers: [...base.filter((p) => p.channel !== 'inapp'), ackingInApp],
  });
  await migrate(c.db());
});
beforeEach(async () => {
  await truncateAll(c.db());
  await c.templateRepo().seed(loadTemplateSources());
  await c.registry().sync();
  fastClient = false;
});
afterAll(() => c.close());

async function eventNotifications(userId: string): Promise<NotificationRow[]> {
  const r = await c.ingestion().ingest(
    {
      eventType: 'TXNX-001',
      userId,
      occurredAt: new Date().toISOString(),
      payload: { ...SAMPLE_PAYLOADS['TXNX-001'], orderId: randomUUID().slice(0, 8) },
    },
    'test',
    'corr-race-0001',
  );
  await c.processor().process({
    eventId: r.eventId,
    eventType: 'TXNX-001',
    userId,
    occurredAt: '',
    correlationId: 'corr-race-0001',
    schemaVersion: 1,
  });
  return c.notifications().byEvent(r.eventId);
}
const msg = (n: NotificationRow) => ({
  notificationId: n.id,
  createdAt: new Date(n.created_at).toISOString(),
  retry: n.retry_count,
  correlationId: n.correlation_id,
});

describe('races between delivery and acknowledgements', () => {
  it('keeps an in-app ack that arrives before the SENT commit (no lost DELIVERED)', async () => {
    fastClient = true;
    const userId = await createUser(c);
    const inapp = (await eventNotifications(userId)).find((n) => n.channel === 'inapp')!;
    expect(await c.dispatcher().handle(msg(inapp))).toBe('ack');
    const n = await c.notifications().require(inapp.id);
    expect(n.state).toBe('DELIVERED');
    expect(n.provider).toBe('socketio'); // provider details still recorded
    expect(n.sent_at).not.toBeNull();
    const history = (await c.notifications().history(inapp.id)).map((h) => h.to_state);
    expect(history.slice(-2)).toEqual(['QUEUED', 'DELIVERED']);
  });

  it('parks a provider receipt that arrives before the SENT commit and replays it', async () => {
    const userId = await createUser(c);
    const push = (await eventNotifications(userId)).find((n) => n.channel === 'push')!;
    // Receipt for a message id the system has not committed yet.
    const early = await c
      .webhooks()
      .apply(
        'mock-push',
        [{ providerEventId: 'early-1', providerMessageId: 'pm-early', status: 'DELIVERED' }],
        '{}',
      );
    expect(early.UNKNOWN_MESSAGE).toBe(1);
    // The provider accepted the message (attempt recorded) but the worker had not committed yet.
    await c.db()('delivery_attempts').insert({
      notification_id: push.id,
      attempt_number: 1,
      provider: 'mock-push',
      channel: 'push',
      status: 'SUCCESS',
      provider_message_id: 'pm-early',
      cost_micros: 0,
    });
    await c.dispatcher().handle(msg(push));
    const n = await c.notifications().require(push.id);
    expect(n.state).toBe('DELIVERED');
    const receipt = await c
      .db()('webhook_receipts')
      .where({ provider_event_id: 'early-1' })
      .first();
    expect(receipt).toMatchObject({ outcome: 'APPLIED_LATE', notification_id: push.id });
  });

  it('accepts an in-app ack while the notification is still queued', async () => {
    const userId = await createUser(c);
    const inapp = (await eventNotifications(userId)).find((n) => n.channel === 'inapp')!;
    const acked = await c.notificationService().acknowledge(userId, inapp.id, 'corr-ack-1');
    expect(acked.state).toBe('DELIVERED');
    expect(await c.dispatcher().handle(msg(inapp))).toBe('ack'); // nothing left to send
    expect((await c.notifications().require(inapp.id)).state).toBe('DELIVERED');
  });
});
