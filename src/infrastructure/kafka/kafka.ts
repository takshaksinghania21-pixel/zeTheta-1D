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
  financialEvents: string;
  lifecycle: string;
  eventsDlq: string;
}

export function topicNames(prefix: string): TopicNames {
  return {
    financialEvents: `${prefix}financial-events.v1`,
    lifecycle: `${prefix}notification-lifecycle.v1`,
    eventsDlq: `${prefix}financial-events.dlq.v1`,
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
      topic: names.financialEvents,
      numPartitions: cfg.partitions,
      configEntries: [{ name: 'retention.ms', value: String(7 * 86400000) }],
    },
    {
      topic: names.lifecycle,
      numPartitions: cfg.partitions,
      configEntries: [{ name: 'retention.ms', value: String(3 * 86400000) }],
    },
    {
      topic: names.eventsDlq,
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
 * Runs a consumer that commits offsets only after the handler resolves
 * (at-least-once). Handler errors propagate so kafkajs re-delivers from the
 * last committed offset; handlers must therefore be idempotent.
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
    autoCommit: true,
    autoCommitInterval: 1000,
    partitionsConsumedConcurrently: opts.concurrency,
    eachMessage: handler,
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

/** Total lag for a consumer group across partitions of a topic. */
export async function consumerLag(admin: Admin, groupId: string, topic: string): Promise<number> {
  const [latest, committed] = await Promise.all([
    admin.fetchTopicOffsets(topic),
    admin.fetchOffsets({ groupId, topics: [topic] }),
  ]);
  const committedMap = new Map(
    (committed[0]?.partitions ?? []).map((p) => [p.partition, Number(p.offset)]),
  );
  let lag = 0;
  for (const p of latest) {
    const high = Number(p.high);
    const c = committedMap.get(p.partition) ?? -1;
    lag += c < 0 ? high - Number(p.low) : Math.max(0, high - c);
  }
  return lag;
}
