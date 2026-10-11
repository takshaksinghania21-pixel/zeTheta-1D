import type { Consumer } from 'kafkajs';
import { z } from 'zod';
import type { Container } from '../container';
import { runWithContext, normaliseCorrelationId } from '../common/context';
import { NonRetryableError } from '../common/errors';
import { metrics } from '../common/metrics';
import { sanitizeForLog } from '../common/pii';
import { CHANNELS, type Channel } from '../domain/types';
import { consumerLag, headerString, runConsumer } from '../infrastructure/kafka/kafka';
import { consumeQueue, queueDepths } from '../infrastructure/rabbitmq/rabbitmq';
import { kafkaEventSchema } from '../modules/events/ingestion';
import type { LifecycleEvent } from '../modules/notifications/types';

export interface RunningWorker {
  name: string;
  stop(): Promise<void>;
}

const deliveryMessageSchema = z.strictObject({
  notificationId: z.uuid(),
  createdAt: z.iso.datetime(),
  retry: z.number().int().min(0),
  correlationId: z.string().min(1).max(200),
});

export const consumerGroups = (prefix: string) => ({
  events: `${prefix}notification-engine.event-consumer`,
  analytics: `${prefix}notification-engine.analytics`,
});

/** Kafka financial-events consumer → EventProcessor. */
export async function startEventConsumer(c: Container): Promise<RunningWorker> {
  const log = c.logger.child({ component: 'event-consumer' });
  const consumer: Consumer = await runConsumer(
    c.kafka(),
    {
      groupId: consumerGroups(c.config.KAFKA_TOPIC_PREFIX).events,
      topic: c.topics.financialEvents,
      concurrency: c.config.KAFKA_CONSUMER_CONCURRENCY,
    },
    async ({ message, partition }) => {
      const correlationId = normaliseCorrelationId(
        headerString(message.headers, 'x-correlation-id'),
      );
      await runWithContext({ correlationId }, async () => {
        let parsed: z.infer<typeof kafkaEventSchema>;
        try {
          parsed = kafkaEventSchema.parse(JSON.parse(message.value?.toString('utf8') ?? 'null'));
        } catch (err) {
          // Poison message: park it and move on (offset advances).
          await c.dlqRepo().insert(c.db(), {
            source: 'POISON',
            reasonCode: 'INVALID_KAFKA_MESSAGE',
            reasonMessage: err instanceof Error ? err.message : 'unparseable',
            attempts: 1,
            payload: { topic: c.topics.financialEvents, partition, offset: message.offset },
          });
          log.error(
            { partition, offset: message.offset },
            'poison message on financial-events topic',
          );
          return;
        }
        try {
          const result = await c.processor().process(parsed);
          log.debug({ eventId: parsed.eventId, result }, 'event processed');
          (await c.outboxRelay()).kick();
        } catch (err) {
          if (err instanceof NonRetryableError) {
            await c.dlqRepo().insert(c.db(), {
              source: 'EVENT',
              eventId: null,
              reasonCode: err.reasonCode,
              reasonMessage: err.message,
              attempts: 1,
              payload: { eventId: parsed.eventId },
            });
            log.error(
              { eventId: parsed.eventId, reason: err.reasonCode },
              'non-retryable event failure',
            );
            return;
          }
          log.error(
            { err: sanitizeForLog(err), eventId: parsed.eventId },
            'retryable event failure; offset not committed',
          );
          throw err;
        }
      });
    },
    log,
  );
  return { name: 'event-consumer', stop: () => consumer.disconnect() };
}

/** RabbitMQ delivery queue consumers → DeliveryDispatcher. */
export async function startDispatcher(
  c: Container,
  channels: readonly Channel[] = CHANNELS,
): Promise<RunningWorker> {
  const log = c.logger.child({ component: 'dispatcher' });
  const consumers: Awaited<ReturnType<typeof consumeQueue>>[] = [];
  for (const channel of channels) {
    consumers.push(
      await consumeQueue(
        c.rabbit(),
        c.topology.deliveryQueue(channel),
        c.config.RABBITMQ_PREFETCH,
        async (msg) => {
          const parsed = deliveryMessageSchema.safeParse(
            (() => {
              try {
                return JSON.parse(msg.content.toString('utf8')) as unknown;
              } catch {
                return null;
              }
            })(),
          );
          if (!parsed.success) {
            log.error({ queue: channel }, 'malformed delivery message; dead-lettering');
            return 'poison';
          }
          return runWithContext(
            { correlationId: normaliseCorrelationId(parsed.data.correlationId) },
            async () => {
              const outcome = await c.dispatcher().handle(parsed.data);
              if (outcome === 'ack') (await c.outboxRelay()).kick();
              return outcome;
            },
          );
        },
        log,
      ),
    );
  }
  return {
    name: 'dispatcher',
    stop: async () => {
      for (const consumer of consumers) await consumer.cancel();
      // Wait for in-flight deliveries to finish recording their outcome.
      const deadline = Date.now() + 15000;
      while (consumers.some((x) => x.inFlight() > 0) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      for (const consumer of consumers) await consumer.channel.close().catch(() => undefined);
    },
  };
}

/** Persists poison messages that RabbitMQ dead-lettered into the DLQ queue. */
export async function startDlqIngest(c: Container): Promise<RunningWorker> {
  const log = c.logger.child({ component: 'dlq-ingest' });
  const consumer = await consumeQueue(
    c.rabbit(),
    c.topology.dlqQueue,
    50,
    async (msg) => {
      if (msg.fields.routingKey === 'exhausted') return 'ack'; // already recorded in PostgreSQL by the dispatcher
      let body: unknown;
      try {
        body = JSON.parse(msg.content.toString('utf8'));
      } catch {
        body = { raw: msg.content.toString('utf8').slice(0, 500) };
      }
      const notificationId =
        typeof body === 'object' &&
        body !== null &&
        'notificationId' in body &&
        typeof body.notificationId === 'string'
          ? body.notificationId
          : null;
      await c.dlqRepo().insert(c.db(), {
        source: 'POISON',
        notificationId,
        reasonCode: 'POISON_MESSAGE',
        reasonMessage: 'Message rejected by a delivery consumer',
        attempts: 1,
        payload: {
          body: sanitizeForLog(body) as Record<string, unknown>,
          routingKey: msg.fields.routingKey,
        },
      });
      log.warn({ notificationId }, 'poison message recorded in DLQ');
      return 'ack';
    },
    log,
  );
  return { name: 'dlq-ingest', stop: consumer.cancel };
}

export async function startOutboxRelay(c: Container): Promise<RunningWorker> {
  const relay = await c.outboxRelay();
  relay.start();
  return { name: 'outbox-relay', stop: () => relay.stop() };
}

function loop(
  name: string,
  intervalMs: number,
  fn: () => Promise<unknown>,
  onError: (err: unknown) => void,
): RunningWorker {
  let stopped = false;
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const tick = (): void => {
    if (stopped) return;
    running = fn()
      .then(() => undefined, onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return {
    name,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}

export function startScheduler(c: Container): RunningWorker {
  const log = c.logger.child({ component: 'scheduler' });
  const onError = (err: unknown): void => {
    log.error({ err }, 'scheduler loop error');
  };
  const s = c.scheduler();
  const loops = [
    loop(
      'scheduler.due',
      c.config.SCHEDULER_POLL_MS,
      async () => {
        let n: number;
        do n = await s.runDue();
        while (n > 0);
      },
      onError,
    ),
    loop('scheduler.sweep', 60000, () => s.sweep(), onError),
    loop('scheduler.partitions', 6 * 3600000, () => s.maintainPartitions(), onError),
    loop('scheduler.retention', 24 * 3600000, () => s.runRetention(), onError),
  ];
  return {
    name: 'scheduler',
    stop: async () => {
      await Promise.all(loops.map((l) => l.stop()));
    },
  };
}

/** Lifecycle-event consumer → hourly aggregates, plus operational gauges. */
export async function startAnalytics(c: Container): Promise<RunningWorker> {
  const log = c.logger.child({ component: 'analytics' });
  const groups = consumerGroups(c.config.KAFKA_TOPIC_PREFIX);
  const consumer = await runConsumer(
    c.kafka(),
    {
      groupId: groups.analytics,
      topic: c.topics.lifecycle,
      concurrency: c.config.KAFKA_CONSUMER_CONCURRENCY,
    },
    async ({ message }) => {
      let event: LifecycleEvent;
      try {
        const parsed = JSON.parse(
          message.value?.toString('utf8') ?? 'null',
        ) as Partial<LifecycleEvent> | null;
        if (!parsed?.transitionId) throw new Error('missing transitionId');
        event = parsed as LifecycleEvent;
      } catch {
        log.error({ offset: message.offset }, 'unparseable lifecycle event skipped');
        return;
      }
      await c.analytics().ingest(event);
    },
    log,
  );
  const admin = c.kafka().admin();
  await admin.connect();
  const gauges = loop(
    'analytics.gauges',
    15000,
    async () => {
      metrics.consumerLag.set(
        { group: groups.events, topic: c.topics.financialEvents },
        await consumerLag(admin, groups.events, c.topics.financialEvents),
      );
      metrics.consumerLag.set(
        { group: groups.analytics, topic: c.topics.lifecycle },
        await consumerLag(admin, groups.analytics, c.topics.lifecycle),
      );
      await c.dlqRepo().openCount();
      await (await c.outboxRelay()).backlog();
      const depths = await queueDepths(c.rabbit(), [
        ...CHANNELS.map((ch) => c.topology.deliveryQueue(ch)),
        c.topology.dlqQueue,
      ]);
      for (const [q, v] of Object.entries(depths)) metrics.queueDepth.set({ queue: q }, v.messages);
      await c.registry().status();
    },
    (err) => {
      log.warn({ err }, 'gauge refresh failed');
    },
  );
  return {
    name: 'analytics',
    stop: async () => {
      await gauges.stop();
      await consumer.disconnect();
      await admin.disconnect();
    },
  };
}
