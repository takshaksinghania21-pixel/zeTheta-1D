import type { Knex } from 'knex';

const TABLES = [
  'refresh_tokens',
  'principals',
  'audit_logs',
  'analytics_processed',
  'analytics_hourly',
  'digest_suggestions',
  'scheduled_notifications',
  'idempotency_records',
  'outbox',
  'webhook_receipts',
  'provider_configs',
  'dead_letter_entries',
  'template_versions',
  'templates',
  'policy_decisions',
  'delivery_attempts',
  'notification_state_history',
  'notification_keys',
  'notifications',
  'financial_events',
  'ingestion_batches',
  'dnd_registry_entries',
  'dnd_registry_imports',
  'opt_out_events',
  'consent_records',
  'user_preferences',
  'user_contacts',
  'users',
];

export async function migrate(db: Knex): Promise<void> {
  await db.migrate.latest();
}

/** Clears all application tables in the dedicated test database. */
export async function truncateAll(db: Knex): Promise<void> {
  const dbName = (await db.raw('select current_database() as n')).rows[0]?.n ?? '';
  if (!dbName.includes('test'))
    throw new Error(`refusing to truncate non-test database '${dbName}'`);
  await db.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
