import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, type AppConfig } from '../../src/config/env';

/**
 * Configuration for integration/e2e tests. Uses a dedicated database
 * (zetheta_test), Redis DB 6 and per-run Kafka/RabbitMQ prefixes so test runs
 * never touch development data. Override with TEST_* environment variables.
 */
export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const run = randomUUID().slice(0, 8);
  const dbUrl =
    process.env.TEST_DATABASE_URL ??
    (process.env.DATABASE_URL ?? '').replace(/\/[^/]+$/, '/zetheta_test');
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/6';
  return loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DATABASE_URL: dbUrl,
    REDIS_URL: redisUrl,
    KAFKA_BROKERS: process.env.TEST_KAFKA_BROKERS ?? process.env.KAFKA_BROKERS ?? 'localhost:9092',
    KAFKA_TOPIC_PREFIX: `test-${run}.`,
    KAFKA_EVENT_PARTITIONS: '2',
    RABBITMQ_URL: process.env.TEST_RABBITMQ_URL ?? process.env.RABBITMQ_URL ?? '',
    RABBITMQ_PREFIX: `test-${run}.`,
    POLICY_FILE: path.resolve(__dirname, '../fixtures/policy.test.yaml'),
    PROVIDER_MODE: 'mock',
    SMS_PROVIDERS: 'mock-sms-primary,mock-sms-secondary',
    EMAIL_PROVIDERS: 'mock-email',
    PUSH_PROVIDERS: 'mock-push',
    WHATSAPP_PROVIDERS: 'mock-whatsapp',
    INAPP_PROVIDERS: 'socketio',
    MOCK_RECEIPT_CALLBACK_URL: '',
    OUTBOX_POLL_MS: '50',
    SCHEDULER_POLL_MS: '100',
    WEBHOOK_SIGNATURE_REQUIRED: 'true',
    JWT_SECRET: process.env.JWT_SECRET ?? 'test-secret-test-secret-test-secret-0001',
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY ?? Buffer.alloc(32, 1).toString('base64'),
    DATA_HASH_KEY: process.env.DATA_HASH_KEY ?? Buffer.alloc(32, 2).toString('base64'),
    WEBHOOK_SIGNING_SECRET: process.env.WEBHOOK_SIGNING_SECRET ?? 'test-webhook-secret-0001',
    RATE_LIMIT_STANDARD_PER_MIN: '100000',
    RATE_LIMIT_PREFERENCES_PER_MIN: '10',
    CORS_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}
