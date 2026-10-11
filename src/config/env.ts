import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));
const base64Key = z
  .string()
  .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64 encoded');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('zetheta-notification-engine'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.string().default('false'),
  CORS_ORIGINS: csv,

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DATABASE_SSL: bool.default(false),

  REDIS_URL: z.string().min(1),

  KAFKA_BROKERS: csv,
  KAFKA_CLIENT_ID: z.string().default('zetheta-notify'),
  KAFKA_TOPIC_PREFIX: z.string().default('zetheta.'),
  KAFKA_EVENT_PARTITIONS: z.coerce.number().int().min(1).max(256).default(6),
  KAFKA_REPLICATION_FACTOR: z.coerce.number().int().min(1).max(5).default(1),
  KAFKA_CONSUMER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(3),
  KAFKA_SASL_MECHANISM: z
    .enum(['', 'plain', 'scram-sha-256', 'scram-sha-512'])
    .default('')
    .transform((v) => (v === '' ? undefined : v)),
  KAFKA_SASL_USERNAME: optionalString,
  KAFKA_SASL_PASSWORD: optionalString,
  KAFKA_SSL: bool.default(false),

  RABBITMQ_URL: z.string().min(1),
  RABBITMQ_PREFIX: z.string().default('zetheta.'),
  RABBITMQ_PREFETCH: z.coerce.number().int().min(1).max(1000).default(20),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('zetheta-notification-engine'),
  JWT_AUDIENCE: z.string().default('zetheta-api'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(300).default(1209600),
  DATA_ENCRYPTION_KEY: base64Key,
  DATA_ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[a-z0-9]{1,16}$/)
    .default('k1'),
  DATA_HASH_KEY: base64Key,

  RATE_LIMIT_STANDARD_PER_MIN: z.coerce.number().int().min(1).default(100),
  RATE_LIMIT_WEBHOOK_PER_MIN: z.coerce.number().int().min(1).default(1000),
  RATE_LIMIT_PREFERENCES_PER_MIN: z.coerce.number().int().min(1).default(10),

  PROVIDER_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  SMS_PROVIDERS: csv,
  EMAIL_PROVIDERS: csv,
  PUSH_PROVIDERS: csv,
  WHATSAPP_PROVIDERS: csv,
  INAPP_PROVIDERS: csv,
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
  MOCK_RECEIPT_CALLBACK_URL: optionalString,
  MOCK_RECEIPT_DELAY_MS: z.coerce.number().int().min(0).default(250),

  WEBHOOK_SIGNING_SECRET: z.string().min(16),
  WEBHOOK_SIGNATURE_REQUIRED: bool.default(true),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_FROM_NUMBER: optionalString,
  TWILIO_BASE_URL: z.url().default('https://api.twilio.com'),

  MSG91_AUTH_KEY: optionalString,
  MSG91_FLOW_ID: optionalString,
  MSG91_SENDER_ID: optionalString,
  MSG91_BASE_URL: z.url().default('https://control.msg91.com'),
  MSG91_WEBHOOK_SECRET: optionalString,

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  EMAIL_FROM: z.string().default('Zetheta Alerts <alerts@example.test>'),

  FCM_PROJECT_ID: optionalString,
  FCM_CLIENT_EMAIL: optionalString,
  FCM_PRIVATE_KEY_BASE64: optionalString,
  FCM_BASE_URL: z.url().default('https://fcm.googleapis.com'),
  FCM_TOKEN_URL: z.url().default('https://oauth2.googleapis.com/token'),

  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_ACCESS_TOKEN: optionalString,
  WHATSAPP_APP_SECRET: optionalString,
  WHATSAPP_VERIFY_TOKEN: optionalString,
  WHATSAPP_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v21.0'),
  WHATSAPP_BASE_URL: z.url().default('https://graph.facebook.com'),

  DND_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(3600),
  DND_STALE_AFTER_HOURS: z.coerce.number().int().min(1).default(168),
  RETENTION_DAYS: z.coerce.number().int().min(1).default(90),

  OUTBOX_POLL_MS: z.coerce.number().int().min(10).default(200),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(5000).default(200),
  SCHEDULER_POLL_MS: z.coerce.number().int().min(50).default(1000),
  RETRY_SWEEP_STALE_SECONDS: z.coerce.number().int().min(10).default(300),
  /** Alternative policy file (tests use faster retry timings). */
  POLICY_FILE: optionalString,
});

export type AppConfig = z.infer<typeof envSchema>;

/**
 * Parses and validates configuration. Production adds hard requirements so a
 * misconfigured deployment fails fast instead of running insecurely.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.SMS_PROVIDERS.length === 0)
    cfg.SMS_PROVIDERS = ['mock-sms-primary', 'mock-sms-secondary'];
  if (cfg.EMAIL_PROVIDERS.length === 0) cfg.EMAIL_PROVIDERS = ['mock-email'];
  if (cfg.PUSH_PROVIDERS.length === 0) cfg.PUSH_PROVIDERS = ['mock-push'];
  if (cfg.WHATSAPP_PROVIDERS.length === 0) cfg.WHATSAPP_PROVIDERS = ['mock-whatsapp'];
  if (cfg.INAPP_PROVIDERS.length === 0) cfg.INAPP_PROVIDERS = ['socketio'];

  if (cfg.NODE_ENV === 'production') {
    const problems: string[] = [];
    // Webhook verification is never optional in production.
    cfg.WEBHOOK_SIGNATURE_REQUIRED = true;
    if (cfg.PROVIDER_MODE === 'mock')
      problems.push('PROVIDER_MODE=mock is not allowed in production');
    if (/CHANGE_ME/i.test(cfg.JWT_SECRET)) problems.push('JWT_SECRET still contains a placeholder');
    if (/CHANGE_ME/i.test(cfg.WEBHOOK_SIGNING_SECRET))
      problems.push('WEBHOOK_SIGNING_SECRET is a placeholder');
    if (cfg.DATA_ENCRYPTION_KEY === cfg.DATA_HASH_KEY)
      problems.push('DATA_ENCRYPTION_KEY and DATA_HASH_KEY must differ');
    if (cfg.CORS_ORIGINS.includes('*'))
      problems.push('CORS_ORIGINS must not contain * in production');
    const allProviders = [
      ...cfg.SMS_PROVIDERS,
      ...cfg.EMAIL_PROVIDERS,
      ...cfg.PUSH_PROVIDERS,
      ...cfg.WHATSAPP_PROVIDERS,
    ];
    if (allProviders.some((p) => p.startsWith('mock')))
      problems.push('mock providers are not allowed in production');
    if (problems.length > 0)
      throw new Error(`Unsafe production configuration: ${problems.join('; ')}`);
  }
  return cfg;
}
