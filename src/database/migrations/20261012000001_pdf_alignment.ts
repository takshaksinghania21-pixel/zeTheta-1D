import type { Knex } from 'knex';

/**
 * Aligns the schema with PDF §A8 (p.17–18) and Day 2/9:
 *  - the A8.2 indexes that were missing (composite user/status/channel, BRIN on
 *    created_at, event_type+created_at, GIN on the personalisation payload);
 *  - read-only views under the PDF table names over the implementation tables;
 *  - DLQ failure classification (transient / permanent / configuration);
 *  - digest suggestions count notifications (PDF: "> 8/day"), not cap hits.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX notifications_user_status_channel_idx ON notifications (user_id, state, channel);
    CREATE INDEX notifications_created_brin_idx ON notifications USING brin (created_at);
    CREATE INDEX notifications_event_type_created_idx ON notifications (event_type, created_at);
    -- Personalisation data is the event payload (scrubbed after the retention period).
    CREATE INDEX financial_events_payload_gin_idx ON financial_events USING gin (payload jsonb_path_ops);

    ALTER TABLE dead_letter_entries ADD COLUMN classification text
      CHECK (classification IN ('TRANSIENT','PERMANENT','CONFIGURATION'));
    CREATE INDEX dead_letter_classification_idx ON dead_letter_entries (classification, created_at DESC);

    ALTER TABLE digest_suggestions RENAME COLUMN cap_hits TO notifications_in_window;

    CREATE VIEW notification_state_log AS
      SELECT seq AS id, notification_id, from_state AS from_status, to_state AS to_status,
             actor, metadata, created_at
      FROM notification_state_history;
    CREATE VIEW dead_letter_queue AS
      SELECT id, notification_id, payload AS original_event, reason_code AS failure_reason,
             attempts AS retry_count, reason_message AS last_error,
             status <> 'OPEN' AS resolved, resolved_by, resolved_at,
             CASE status WHEN 'RETRIED' THEN 'retried' WHEN 'DISCARDED' THEN 'discarded'
                         WHEN 'RESOLVED' THEN 'manual_send' END AS resolution_action,
             classification, created_at
      FROM dead_letter_entries;
    CREATE VIEW delivery_providers AS
      SELECT name, channel, enabled, priority, cost_micros, rate_limit_per_minute, timeout_ms,
             updated_at
      FROM provider_configs;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP VIEW IF EXISTS delivery_providers, dead_letter_queue, notification_state_log;
    ALTER TABLE digest_suggestions RENAME COLUMN notifications_in_window TO cap_hits;
    DROP INDEX IF EXISTS dead_letter_classification_idx;
    ALTER TABLE dead_letter_entries DROP COLUMN IF EXISTS classification;
    DROP INDEX IF EXISTS financial_events_payload_gin_idx, notifications_event_type_created_idx,
      notifications_created_brin_idx, notifications_user_status_channel_idx;
  `);
}
