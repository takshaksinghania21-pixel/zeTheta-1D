import type { Container } from '../container';
import { ensureTopics } from '../infrastructure/kafka/kafka';
import { assertTopology } from '../infrastructure/rabbitmq/rabbitmq';

/** Idempotently declares Kafka topics, RabbitMQ topology and provider config rows. */
export async function ensureInfrastructure(
  c: Container,
  parts: { kafka?: boolean; rabbit?: boolean; providers?: boolean } = {
    kafka: true,
    rabbit: true,
    providers: true,
  },
): Promise<void> {
  if (parts.kafka) {
    const admin = c.kafka().admin();
    await admin.connect();
    try {
      await ensureTopics(admin, c.topics, {
        partitions: c.config.KAFKA_EVENT_PARTITIONS,
        replicationFactor: c.config.KAFKA_REPLICATION_FACTOR,
      });
    } finally {
      await admin.disconnect();
    }
  }
  if (parts.rabbit) {
    const model = await c.rabbit().connect();
    const ch = await model.createChannel();
    try {
      await assertTopology(ch, c.topology);
    } finally {
      await ch.close();
    }
  }
  if (parts.providers) await c.registry().sync();
}
