import type { Channel as AmqpChannel, GetMessage } from 'amqplib';
import { Container } from '../../src/container';
import {
  consumerLag,
  ensureTopics,
  headerString,
  runConsumer,
} from '../../src/infrastructure/kafka/kafka';
import { enqueueOutbox, OutboxRelay } from '../../src/infrastructure/outbox/outbox';
import {
  assertTopology,
  consumeQueue,
  queueDepths,
} from '../../src/infrastructure/rabbitmq/rabbitmq';
import { migrate, truncateAll } from '../helpers/db';
import { testConfig } from '../helpers/env';
import { waitFor } from '../helpers/stack';

let c: Container;
let ch: AmqpChannel;

beforeAll(async () => {
  c = new Container(testConfig());
  await migrate(c.db());
  await truncateAll(c.db());
  const admin = c.kafka().admin();
  await admin.connect();
  await ensureTopics(admin, c.topics, { partitions: 2, replicationFactor: 1 });
  await admin.disconnect();
  const model = await c.rabbit().connect();
  ch = await model.createChannel();
  await assertTopology(ch, c.topology);
});

afterAll(async () => {
  for (const q of [
    ...['sms', 'email', 'push', 'whatsapp', 'inapp'].map(
      (x) => `${c.config.RABBITMQ_PREFIX}delivery.${x}`,
    ),
    c.topology.dlqQueue,
  ]) {
    await ch.deleteQueue(q).catch(() => undefined);
  }
  for (const ex of [c.topology.deliveryExchange, c.topology.dlx])
    await ch.deleteExchange(ex).catch(() => undefined);
  await ch.close().catch(() => undefined);
  const admin = c.kafka().admin();
  await admin.connect();
  await admin.deleteTopics({ topics: Object.values(c.topics) }).catch(() => undefined);
  await admin.disconnect();
  await c.close();
});

describe('Kafka', () => {
  it('creates topics explicitly with the configured partitions (idempotent)', async () => {
    const admin = c.kafka().admin();
    await admin.connect();
    await ensureTopics(admin, c.topics, { partitions: 2, replicationFactor: 1 });
    const meta = await admin.fetchTopicMetadata({ topics: [c.topics.events, c.topics.critical] });
    expect(meta.topics.map((t) => t.partitions.length)).toEqual([2, 2]);
    await admin.disconnect();
  });

  it('uses the PDF topic names and routes CRITICAL events to the dedicated critical topic', () => {
    const p = c.config.KAFKA_TOPIC_PREFIX;
    expect(c.topics).toMatchObject({
      events: `${p}notification-events`,
      critical: `${p}notification-critical`,
      dlq: `${p}notification-dlq`,
    });
    expect(c.eventTopic('RISK-001')).toBe(c.topics.critical);
    expect(c.eventTopic('MKTX-002')).toBe(c.topics.critical);
    expect(c.eventTopic('TXNX-001')).toBe(c.topics.events);
  });

  it('publishes and consumes with key ordering, headers (correlation id) and committed offsets', async () => {
    const producer = await c.producer();
    const received: { value: string; correlationId: string | undefined; partition: number }[] = [];
    const groupId = `${c.config.KAFKA_TOPIC_PREFIX}itest-group`;
    const consumer = await runConsumer(
      c.kafka(),
      { groupId, topic: c.topics.events, concurrency: 2 },
      async ({ message, partition }) => {
        received.push({
          value: message.value?.toString() ?? '',
          correlationId: headerString(message.headers, 'x-correlation-id'),
          partition,
        });
        return Promise.resolve();
      },
      c.logger,
    );
    await producer.send({
      topic: c.topics.events,
      messages: Array.from({ length: 6 }, (_, i) => ({
        key: 'same-user',
        value: `m${i}`,
        headers: { 'x-correlation-id': `corr-${i}` },
      })),
    });
    await waitFor(
      () => Promise.resolve(received.length),
      (n) => n === 6,
      20000,
    );
    expect(received.map((r) => r.value)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']); // per-key ordering
    expect(new Set(received.map((r) => r.partition)).size).toBe(1);
    expect(received[3]?.correlationId).toBe('corr-3');
    // Offsets are committed manually after each handler resolves.
    const admin = c.kafka().admin();
    await admin.connect();
    await waitFor(
      async () => (await consumerLag(admin, groupId, c.topics.events)).total,
      (lag) => lag === 0,
      10000,
    );
    await consumer.disconnect();
    await admin.disconnect();
  });
});

describe('RabbitMQ topology', () => {
  const take = async (queue: string): Promise<GetMessage[]> => {
    const out: GetMessage[] = [];
    for (;;) {
      const m = await ch.get(queue, { noAck: false });
      if (!m) return out;
      out.push(m);
      ch.ack(m);
    }
  };

  it('delivers higher-priority messages first (x-max-priority)', async () => {
    const q = c.topology.deliveryQueue('sms');
    for (const [i, p] of [1, 1, 10, 4, 7].entries()) {
      await c
        .rabbit()
        .publish(c.topology.deliveryExchange, 'sms', Buffer.from(JSON.stringify({ i, p })), {
          priority: p,
        });
    }
    const msgs = await take(q);
    expect(msgs.map((m) => (JSON.parse(m.content.toString()) as { p: number }).p)).toEqual([
      10, 7, 4, 1, 1,
    ]);
    expect(msgs[0]?.properties.deliveryMode).toBe(2); // persistent
  });

  it('dead-letters rejected (poison) messages to the DLQ queue', async () => {
    await c.rabbit().publish(c.topology.deliveryExchange, 'push', Buffer.from('not json'), {});
    const seen: string[] = [];
    const consumer = await consumeQueue(
      c.rabbit(),
      c.topology.deliveryQueue('push'),
      5,
      (m) => {
        seen.push(m.content.toString());
        return Promise.resolve('poison');
      },
      c.logger,
    );
    await waitFor(
      () => Promise.resolve(seen.length),
      (n) => n === 1,
      5000,
    );
    await consumer.cancel();
    const dlq = await waitFor(
      () => take(c.topology.dlqQueue),
      (m) => m.length === 1,
      5000,
      100,
    );
    expect(dlq[0]?.content.toString()).toBe('not json');
    expect(dlq[0]?.fields.routingKey).toBe('poison');
  });
});

describe('Transactional outbox relay', () => {
  it('publishes Kafka and RabbitMQ rows and marks them published', async () => {
    await c.db().transaction((trx) =>
      enqueueOutbox(trx, [
        {
          destination: 'KAFKA',
          topic: c.topics.lifecycle,
          key: 'k',
          payload: { hello: 'kafka' },
          headers: { 'x-correlation-id': 'outbox-test' },
        },
        {
          destination: 'RABBITMQ',
          exchange: c.topology.deliveryExchange,
          routingKey: 'whatsapp',
          payload: { hello: 'rabbit' },
          priority: 7,
          messageId: 'm-1',
        },
      ]),
    );
    const relay = await c.outboxRelay();
    expect(await relay.publishBatch()).toBe(2);
    expect(await relay.backlog()).toBe(0);
    const m = await waitFor(
      () => ch.get(c.topology.deliveryQueue('whatsapp')),
      (x) => x !== false,
      5000,
    );
    if (m === false) throw new Error('no message');
    expect(JSON.parse(m.content.toString())).toEqual({ hello: 'rabbit' });
    expect(m.properties.priority).toBe(7);
    expect(m.properties.messageId).toBe('m-1');
    ch.ack(m);
  });

  it('keeps rows and backs off when the broker is unavailable (no message loss)', async () => {
    await c.db().transaction((trx) =>
      enqueueOutbox(trx, [
        {
          destination: 'RABBITMQ',
          exchange: c.topology.deliveryExchange,
          routingKey: 'sms',
          payload: { x: 1 },
        },
      ]),
    );
    const broken = new OutboxRelay(c.db(), null, null, c.logger, { pollMs: 10, batchSize: 10 });
    expect(await broken.publishBatch()).toBe(0);
    const row = (await c.db()('outbox').whereNull('published_at').first()) as {
      attempts: number;
      last_error: string;
      available_at: Date;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/not configured/);
    expect(new Date(row.available_at).getTime()).toBeGreaterThan(Date.now());
    await c.db()('outbox').whereNull('published_at').update({ available_at: c.db().fn.now() });
    expect(await (await c.outboxRelay()).publishBatch()).toBe(1);
    await waitFor(
      () => ch.get(c.topology.deliveryQueue('sms'), { noAck: true }),
      (x) => x !== false,
      5000,
    );
  });

  it('lets concurrent relays split work without double publishing (SKIP LOCKED)', async () => {
    await c.db().transaction((trx) =>
      enqueueOutbox(
        trx,
        Array.from({ length: 40 }, (_, i) => ({
          destination: 'RABBITMQ' as const,
          exchange: c.topology.deliveryExchange,
          routingKey: 'inapp',
          payload: { i },
        })),
      ),
    );
    const relayA = new OutboxRelay(c.db(), null, c.rabbit(), c.logger, {
      pollMs: 10,
      batchSize: 10,
    });
    const relayB = new OutboxRelay(c.db(), null, c.rabbit(), c.logger, {
      pollMs: 10,
      batchSize: 10,
    });
    let total = 0;
    for (let i = 0; i < 4; i++)
      total += (await Promise.all([relayA.publishBatch(), relayB.publishBatch()])).reduce(
        (a, b) => a + b,
        0,
      );
    expect(total).toBe(40);
    const depth = await waitFor(
      () => queueDepths(c.rabbit(), [c.topology.deliveryQueue('inapp')]),
      (d) => d[c.topology.deliveryQueue('inapp')]?.messages === 40,
      5000,
    );
    expect(depth[c.topology.deliveryQueue('inapp')]?.messages).toBe(40);
  });
});

describe('Redis retry schedule (sorted set)', () => {
  const target = (i: number) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    created_at: new Date('2026-10-12T00:00:00Z'),
    channel: 'sms' as const,
    priority: 'HIGH' as const,
    correlation_id: `corr-${i}`,
  });
  const queuedRetries = async () =>
    (await c
      .db()('outbox')
      .where({ destination: 'RABBITMQ', target: c.topology.deliveryExchange })) as {
      routing_key: string;
      payload: { notificationId: string; retry: number };
    }[];

  beforeEach(async () => {
    await c.db()('outbox').del();
    await c.redis().del(`${c.config.RABBITMQ_PREFIX}retry:schedule`);
  });

  it('releases only due retries, in due order, exactly once across concurrent pollers', async () => {
    const t0 = new Date('2026-10-12T10:00:00Z');
    const rs = c.retryScheduler();
    await rs.schedule(target(2), 2, new Date(t0.getTime() + 2000));
    await rs.schedule(target(1), 1, new Date(t0.getTime() + 1000));
    await rs.schedule(target(3), 3, new Date(t0.getTime() + 60000));
    expect(await rs.releaseDue(t0)).toBe(0);
    const released = await Promise.all([
      rs.releaseDue(new Date(t0.getTime() + 5000)),
      rs.releaseDue(new Date(t0.getTime() + 5000)),
    ]);
    expect(released[0] + released[1]).toBe(2);
    const rows = await queuedRetries();
    expect(rows.map((r) => r.payload.retry).sort()).toEqual([1, 2]);
    expect(rows.every((r) => r.routing_key === 'sms')).toBe(true);
    expect(await rs.depth()).toBe(1);
  });

  it('caps the number released per tick (retry-storm guard)', async () => {
    const { RedisRetryScheduler } = await import('../../src/delivery/retry/retry-scheduler');
    const rs = new RedisRetryScheduler(
      c.redis(),
      c.db(),
      c.factory(),
      c.logger,
      `${c.config.RABBITMQ_PREFIX}retry:schedule`,
      2,
    );
    const now = new Date();
    for (let i = 1; i <= 5; i++) await rs.schedule(target(i), i, now);
    expect(await rs.releaseDue(now)).toBe(2);
    expect(await rs.depth()).toBe(3);
  });
});

describe('worker error paths (no silent failures)', () => {
  const workers = () => import('../../src/workers/workers');

  it('parks poison and non-retryable Kafka events in the DLQ table and on notification-dlq', async () => {
    const { startEventConsumer } = await workers();
    await c.db()('outbox').del();
    const consumer = await startEventConsumer(c);
    const producer = await c.producer();
    const unknownEvent = '00000000-0000-4000-8000-0000000000aa';
    await producer.send({
      topic: c.topics.events,
      messages: [
        { key: 'u', value: 'not json at all', headers: { 'x-correlation-id': 'corr-poison-0001' } },
        {
          key: 'u',
          value: JSON.stringify({
            eventId: unknownEvent,
            eventType: 'TXNX-001',
            userId: '00000000-0000-4000-8000-0000000000bb',
            occurredAt: new Date().toISOString(),
            correlationId: 'corr-unknown-0001',
            schemaVersion: 1,
          }),
        },
      ],
    });
    const entries = await waitFor(
      async () => (await c.dlqRepo().list({ limit: 20, offset: 0 })).items,
      (items) =>
        items.some((e) => e.reason_code === 'INVALID_KAFKA_MESSAGE') &&
        items.some((e) => (e.payload as { eventId?: string }).eventId === unknownEvent),
      20000,
    );
    expect(entries.find((e) => e.reason_code === 'INVALID_KAFKA_MESSAGE')?.classification).toBe(
      'PERMANENT',
    );
    const dlqTopic = await c.db()('outbox').where({ destination: 'KAFKA', target: c.topics.dlq });
    expect(dlqTopic.length).toBeGreaterThanOrEqual(2);
    await consumer.stop();
  });

  it('dead-letters a malformed delivery message and records it via the DLQ ingest worker', async () => {
    const { startDispatcher, startDlqIngest } = await workers();
    const dispatcher = await startDispatcher(c, ['whatsapp']);
    const ingest = await startDlqIngest(c);
    await c
      .rabbit()
      .publish(c.topology.deliveryExchange, 'whatsapp', Buffer.from('{"notificationId":"x"}'), {});
    const entry = await waitFor(
      async () =>
        (await c.dlqRepo().list({ source: 'POISON', limit: 20, offset: 0 })).items.find(
          (e) => e.reason_code === 'POISON_MESSAGE',
        ),
      (e) => e !== undefined,
      20000,
    );
    expect(entry?.payload).toMatchObject({ routingKey: 'poison' });
    await dispatcher.stop();
    await ingest.stop();
  });
});
