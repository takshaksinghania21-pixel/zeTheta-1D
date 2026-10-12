import {
  Kafka,
  logLevel,
  type Admin,
  type Consumer,
  type EachMessagePayload,
  type Producer,
  type SASLOptions,
} from 'kafkajs';
import type { AppConfig } from '../../config/env';
import type { Logger } from '../../common/logger';

export interface TopicNames {
  /** Non-critical financial events, keyed (partitioned) by user id. */
  events: string;
  /** CRITICAL events on their own topic + consumer group (no priority inversion). */
  critical: string;
  lifecycle: string;
  /** Poison / non-retryable events. */
  dlq: string;
}

/** Topic names from PDF Day 3 / Appendix B. */
export function topicNames(prefix: string): TopicNames {
  return {
    events: `${prefix}notification-events`,
    critical: `${prefix}notification-critical`,
    lifecycle: `${prefix}notification-lifecycle`,
    dlq: `${prefix}notification-dlq`,
  };
}

function kafkaLogLevel(level: string): logLevel {
  if (level === 'debug' || level === 'trace') return logLevel.INFO;
  if (level === 'silent') return logLevel.NOTHING;
  return logLevel.ERROR;
}

export function createKafka(cfg: AppConfig, logger: Logger): Kafka {
  process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
  const sasl: SASLOptions | undefined =
    cfg.KAFKA_SASL_MECHANISM && cfg.KAFKA_SASL_USERNAME && cfg.KAFKA_SASL_PASSWORD
      ? ({
          mechanism: cfg.KAFKA_SASL_MECHANISM,
          username: cfg.KAFKA_SASL_USERNAME,
          password: cfg.KAFKA_SASL_PASSWORD,
        } as SASLOptions)
      : undefined;
  return new Kafka({
    clientId: cfg.KAFKA_CLIENT_ID,
    brokers: cfg.KAFKA_BROKERS,
    ssl: cfg.KAFKA_SSL,
    ...(sasl ? { sasl } : {}),
    logLevel: kafkaLogLevel(cfg.LOG_LEVEL),
    logCreator: () => (entry) => {
      const { message, ...extra } = entry.log;
      logger.debug({ kafka: entry.namespace, ...extra }, message);
    },
    retry: { initialRetryTime: 300, retries: 8 },
  });
}

/** Explicit topic configuration (no broker auto-creation). Idempotent. */
export async function ensureTopics(
  admin: Admin,
  names: TopicNames,
  cfg: { partitions: number; replicationFactor: number },
): Promise<void> {
  const existing = new Set(await admin.listTopics());
  const wanted = [
    {
      topic: names.events,
      numPartitions: cfg.partitions,
      configEntries: [{ name: 'retention.ms', value: String(7 * 86400000) }],
    },
    {
      topic: names.critical,
      numPartitions: cfg.partitions,
      configEntries: [{ name: 'retention.ms', value: String(7 * 86400000) }],
    },
    {
      topic: names.lifecycle,
      numPartitions: cfg.partitions,
      configEntries: [{ name: 'retention.ms', value: String(3 * 86400000) }],
    },
    {
      topic: names.dlq,
      numPartitions: 1,
      configEntries: [{ name: 'retention.ms', value: String(30 * 86400000) }],
    },
  ].filter((t) => !existing.has(t.topic));
  if (wanted.length === 0) return;
  await admin.createTopics({
    waitForLeaders: true,
    topics: wanted.map((t) => ({ ...t, replicationFactor: cfg.replicationFactor })),
  });
}

export function createProducer(kafka: Kafka): Producer {
  // Idempotent producer: broker de-duplicates retried sends within a session.
  return kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    allowAutoTopicCreation: false,
  });
}

export interface ConsumerOptions {
  groupId: string;
  topic: string;
  concurrency: number;
  fromBeginning?: boolean;
}

/**
 * Runs a consumer with manual offset management: the offset is committed only
 * after the handler resolves (at-least-once). Handler errors propagate so
 * kafkajs re-delivers from the last committed offset; handlers must therefore
 * be idempotent.
 */
export async function runConsumer(
  kafka: Kafka,
  opts: ConsumerOptions,
  handler: (payload: EachMessagePayload) => Promise<void>,
  logger: Logger,
): Promise<Consumer> {
  const consumer = kafka.consumer({
    groupId: opts.groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    allowAutoTopicCreation: false,
    retry: { retries: 10, initialRetryTime: 500 },
  });
  await consumer.connect();
  await consumer.subscribe({ topic: opts.topic, fromBeginning: opts.fromBeginning ?? true });
  consumer.on(consumer.events.CRASH, (e) => {
    logger.error({ error: e.payload.error, groupId: opts.groupId }, 'kafka consumer crashed');
  });
  await consumer.run({
    autoCommit: false,
    partitionsConsumedConcurrently: opts.concurrency,
    eachMessage: async (payload) => {
      await handler(payload);
      await consumer.commitOffsets([
        {
          topic: payload.topic,
          partition: payload.partition,
          offset: (BigInt(payload.message.offset) + 1n).toString(),
        },
      ]);
    },
  });
  return consumer;
}

export function headerString(
  headers: EachMessagePayload['message']['headers'],
  name: string,
): string | undefined {
  const v = headers?.[name];
  if (v === undefined) return undefined;
  const first = Array.isArray(v) ? v[0] : v;
  return first === undefined ? undefined : Buffer.isBuffer(first) ? first.toString('utf8') : first;
}

/** Consumer-group lag per partition of a topic, and the total. */
export async function consumerLag(
  admin: Admin,
  groupId: string,
  topic: string,
): Promise<{ total: number; partitions: { partition: number; lag: number }[] }> {
  const [latest, committed] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);
  const committedMap = new Map(
    (committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]),
  );
  const partitions = latest.map((p) => {
    const high = Number(p.high);
    const c = committedMap.get(p.partition) ?? -1;
    return { partition: p.partition, lag: c < 0 ? high - Number(p.low) : Math.max(0, high - c) };
  });
  return { total: partitions.reduce((sum, p) => sum + p.lag, 0), partitions };
}
