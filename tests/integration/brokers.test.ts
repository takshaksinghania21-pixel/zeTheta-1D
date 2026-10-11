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
  RETRY_BAND_HEADER,
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
    ...Array.from({ length: 15 }, (_, i) => c.topology.retryQueue(i + 9)),
  ]) {
    await ch.deleteQueue(q).catch(() => undefined);
  }
  for (const ex of [c.topology.deliveryExchange, c.topology.retryExchange, c.topology.dlx])
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
    const meta = await admin.fetchTopicMetadata({ topics: [c.topics.financialEvents] });
    expect(meta.topics[0]?.partitions).toHaveLength(2);
    await admin.disconnect();
  });

  it('publishes and consumes with key ordering, headers (correlation id) and committed offsets', async () => {
    const producer = await c.producer();
    const received: { value: string; correlationId: string | undefined; partition: number }[] = [];
    const groupId = `${c.config.KAFKA_TOPIC_PREFIX}itest-group`;
    const consumer = await runConsumer(
      c.kafka(),
      { groupId, topic: c.topics.financialEvents, concurrency: 2 },
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
      topic: c.topics.financialEvents,
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
    await consumer.disconnect(); // commits resolved offsets
    const admin = c.kafka().admin();
    await admin.connect();
    expect(await consumerLag(admin, groupId, c.topics.financialEvents)).toBe(0);
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

  it('routes a retry to exactly one delay band and dead-letters it back to the channel queue after its TTL', async () => {
    await c.rabbit().publish(c.topology.retryExchange, 'email', Buffer.from('{"retry":1}'), {
      expiration: '300',
      headers: { [RETRY_BAND_HEADER]: '9' },
    });
    const depths = await queueDepths(
      c.rabbit(),
      Array.from({ length: 15 }, (_, i) => c.topology.retryQueue(i + 9)),
    );
    expect(Object.values(depths).reduce((s, d) => s + d.messages, 0)).toBe(1);
    expect(depths[c.topology.retryQueue(9)]?.messages).toBe(1);
    expect(await ch.get(c.topology.deliveryQueue('email'))).toBe(false);
    const msgs = await waitFor(
      () => take(c.topology.deliveryQueue('email')),
      (m) => m.length === 1,
      5000,
      100,
    );
    expect(msgs[0]?.content.toString()).toBe('{"retry":1}');
    expect(msgs[0]?.properties.headers?.['x-death']).toBeDefined();
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
