import type { Knex } from 'knex';

/**
 * Initial schema. Written as raw SQL to use PostgreSQL features directly
 * (partitioning, partial indexes, CHECK constraints, SKIP LOCKED friendly indexes).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      external_ref text UNIQUE,
      display_name text,
      segment text NOT NULL DEFAULT 'RETAIL',
      locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','hi','mr','ta','te')),
      timezone text NOT NULL DEFAULT 'Asia/Kolkata',
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','ANONYMIZED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      anonymized_at timestamptz
    );

    -- Contact details are encrypted at rest (AES-256-GCM); value_hash is a keyed
    -- blind index allowing lookups without decryption; value_masked is display-safe.
    CREATE TABLE user_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel text NOT NULL CHECK (channel IN ('sms','email','push','whatsapp')),
      value_ciphertext text NOT NULL,
      value_hash text NOT NULL,
      value_masked text NOT NULL,
      verified boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INVALID','REMOVED')),
      invalid_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, channel, value_hash)
    );
    CREATE INDEX user_contacts_user_idx ON user_contacts (user_id) WHERE status <> 'REMOVED';
    CREATE INDEX user_contacts_hash_idx ON user_contacts (value_hash);

    CREATE TABLE user_preferences (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      version integer NOT NULL DEFAULT 1,
      preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );

    -- Append-only consent ledger (latest record per channel/purpose wins).
    CREATE TABLE consent_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel text NOT NULL CHECK (channel IN ('sms','email','push','whatsapp','inapp')),
      purpose text NOT NULL CHECK (purpose IN ('TRANSACTIONAL','SERVICE','PROMOTIONAL')),
      status text NOT NULL CHECK (status IN ('GRANTED','REVOKED')),
      source text NOT NULL,
      evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
      recorded_by text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX consent_records_lookup_idx ON consent_records (user_id, channel, purpose, recorded_at DESC);

    CREATE TABLE opt_out_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel text,
      category text,
      source text NOT NULL CHECK (source IN ('CONSENT','PREFERENCE')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX opt_out_events_time_idx ON opt_out_events (created_at);

    -- Authorised DND registry data (imported fixtures or licensed feeds), keyed by phone blind index.
    CREATE TABLE dnd_registry_imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL,
      registry_snapshot_at timestamptz NOT NULL,
      record_count integer NOT NULL,
      imported_by text NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE dnd_registry_entries (
      phone_hash text PRIMARY KEY,
      status text NOT NULL CHECK (status IN ('FULLY_BLOCKED','PARTIALLY_BLOCKED','NOT_REGISTERED')),
      blocked_categories text[] NOT NULL DEFAULT '{}',
      source text NOT NULL,
      registry_updated_at timestamptz NOT NULL,
      import_id uuid REFERENCES dnd_registry_imports(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE ingestion_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      submitted_by text NOT NULL,
      total integer NOT NULL,
      accepted integer NOT NULL,
      duplicates integer NOT NULL,
      rejected integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE financial_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL,
      category text NOT NULL,
      user_id uuid NOT NULL REFERENCES users(id),
      source text NOT NULL,
      idempotency_key text NOT NULL,
      payload_hash text NOT NULL,
      payload jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PUBLISHED','PROCESSING','PROCESSED','FAILED')),
      status_reason text,
      batch_id uuid REFERENCES ingestion_batches(id),
      correlation_id text NOT NULL,
      processed_at timestamptz,
      scrubbed_at timestamptz,
      UNIQUE (source, idempotency_key)
    );
    CREATE INDEX financial_events_user_idx ON financial_events (user_id, received_at DESC);
    CREATE INDEX financial_events_batch_idx ON financial_events (batch_id) WHERE batch_id IS NOT NULL;
    CREATE INDEX financial_events_status_idx ON financial_events (status, received_at) WHERE status IN ('RECEIVED','PUBLISHED','PROCESSING');

    -- Notifications are range-partitioned by creation month. Unique constraints
    -- on a partitioned table must include the partition key, so logical
    -- de-duplication lives in notification_keys (unpartitioned) instead.
    CREATE TABLE notifications (
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at timestamptz NOT NULL DEFAULT now(),
      event_id uuid,
      user_id uuid NOT NULL,
      event_type text NOT NULL,
      category text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('sms','email','push','whatsapp','inapp')),
      priority text NOT NULL CHECK (priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
      regulatory_class text NOT NULL,
      state text NOT NULL,
      locale text NOT NULL,
      template_version integer,
      content jsonb,
      preference_version integer,
      via_override boolean NOT NULL DEFAULT false,
      parent_notification_id uuid,
      digest_id uuid,
      is_digest boolean NOT NULL DEFAULT false,
      attempt_count integer NOT NULL DEFAULT 0,
      retry_count integer NOT NULL DEFAULT 0,
      retry_budget_start integer NOT NULL DEFAULT 0,
      max_retries integer NOT NULL,
      next_attempt_at timestamptz,
      provider text,
      provider_message_id text,
      last_error_code text,
      last_error_message text,
      cost_micros bigint NOT NULL DEFAULT 0,
      correlation_id text NOT NULL,
      queued_at timestamptz,
      sent_at timestamptz,
      delivered_at timestamptz,
      read_at timestamptz,
      clicked_at timestamptz,
      failed_at timestamptz,
      scrubbed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
    CREATE INDEX notifications_id_idx ON notifications (id);
    CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC, id DESC);
    CREATE INDEX notifications_event_idx ON notifications (event_id);
    CREATE INDEX notifications_worker_idx ON notifications (state, next_attempt_at) WHERE state IN ('QUEUED','RETRYING');
    CREATE INDEX notifications_provider_msg_idx ON notifications (provider, provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE INDEX notifications_analytics_idx ON notifications (created_at, channel, event_type);
    CREATE INDEX notifications_digest_idx ON notifications (user_id, state) WHERE state = 'DIGESTED' AND digest_id IS NULL;
    CREATE TABLE notifications_default PARTITION OF notifications DEFAULT;

    CREATE TABLE notification_keys (
      dedupe_key text PRIMARY KEY,
      notification_id uuid NOT NULL,
      notification_created_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE notification_state_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq bigint GENERATED ALWAYS AS IDENTITY,
      notification_id uuid NOT NULL,
      from_state text,
      to_state text NOT NULL,
      actor text NOT NULL,
      correlation_id text NOT NULL,
      reason text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX notification_state_history_idx ON notification_state_history (notification_id, seq);
    CREATE INDEX notification_state_history_time_idx ON notification_state_history (created_at);

    CREATE TABLE delivery_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      notification_id uuid NOT NULL,
      attempt_number integer NOT NULL,
      provider text NOT NULL,
      channel text NOT NULL,
      status text NOT NULL CHECK (status IN ('PENDING','SUCCESS','FAILED','UNKNOWN')),
      error_kind text,
      error_code text,
      error_message text,
      provider_message_id text,
      cost_micros bigint NOT NULL DEFAULT 0,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      latency_ms integer
    );
    CREATE INDEX delivery_attempts_notification_idx ON delivery_attempts (notification_id, started_at);
    CREATE INDEX delivery_attempts_provider_idx ON delivery_attempts (provider, started_at);
    CREATE INDEX delivery_attempts_pending_idx ON delivery_attempts (notification_id) WHERE status = 'PENDING';

    CREATE TABLE policy_decisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid,
      notification_id uuid,
      user_id uuid NOT NULL,
      channel text,
      rule text NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('ALLOW','BLOCK','DEFER','BYPASS','OVERRIDE','FALLBACK','CAP')),
      explanation text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      correlation_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX policy_decisions_event_idx ON policy_decisions (event_id);
    CREATE INDEX policy_decisions_notification_idx ON policy_decisions (notification_id) WHERE notification_id IS NOT NULL;
    CREATE INDEX policy_decisions_user_idx ON policy_decisions (user_id, created_at DESC);
    CREATE INDEX policy_decisions_rule_idx ON policy_decisions (rule, created_at);

    CREATE TABLE templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_type text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('sms','email','push','whatsapp','inapp')),
      locale text NOT NULL CHECK (locale IN ('en','hi','mr','ta','te')),
      active_version integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (event_type, channel, locale)
    );
    CREATE TABLE template_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      version integer NOT NULL,
      subject text,
      title text,
      body text NOT NULL,
      checksum text NOT NULL,
      status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (template_id, version)
    );

    CREATE TABLE dead_letter_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL CHECK (source IN ('DELIVERY','EVENT','POISON')),
      notification_id uuid,
      event_id uuid,
      channel text,
      reason_code text NOT NULL,
      reason_message text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      retry_history jsonb NOT NULL DEFAULT '[]'::jsonb,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RETRIED','RESOLVED','DISCARDED')),
      resolved_by text,
      resolved_at timestamptz,
      resolution_note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX dead_letter_status_idx ON dead_letter_entries (status, created_at DESC);
    CREATE UNIQUE INDEX dead_letter_open_notification_idx ON dead_letter_entries (notification_id) WHERE status = 'OPEN' AND notification_id IS NOT NULL;
    CREATE UNIQUE INDEX dead_letter_open_event_idx ON dead_letter_entries (event_id) WHERE status = 'OPEN' AND source = 'EVENT';

    -- Non-secret provider settings; credentials stay in the environment / secret manager.
    CREATE TABLE provider_configs (
      name text PRIMARY KEY,
      channel text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      priority integer NOT NULL DEFAULT 100,
      cost_micros integer NOT NULL DEFAULT 0,
      rate_limit_per_minute integer NOT NULL DEFAULT 600,
      timeout_ms integer NOT NULL DEFAULT 5000,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE webhook_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      provider_event_id text NOT NULL,
      notification_id uuid,
      provider_message_id text,
      status text,
      occurred_at timestamptz,
      error_code text,
      payload_hash text NOT NULL,
      outcome text NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_event_id)
    );
    -- Receipts that arrived before the provider message id was committed are
    -- parked and replayed when the SENT transition commits.
    CREATE INDEX webhook_receipts_parked_idx ON webhook_receipts (provider_message_id) WHERE outcome = 'UNKNOWN_MESSAGE';

    -- Transactional outbox: rows are written in the same transaction as the
    -- state change and published to Kafka / RabbitMQ by the relay.
    CREATE TABLE outbox (
      id bigserial PRIMARY KEY,
      destination text NOT NULL CHECK (destination IN ('KAFKA','RABBITMQ')),
      target text NOT NULL,
      routing_key text,
      message_key text,
      payload jsonb NOT NULL,
      headers jsonb NOT NULL DEFAULT '{}'::jsonb,
      priority integer,
      expiration_ms integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      available_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      attempts integer NOT NULL DEFAULT 0,
      last_error text
    );
    CREATE INDEX outbox_pending_idx ON outbox (available_at, id) WHERE published_at IS NULL;

    CREATE TABLE idempotency_records (
      scope text NOT NULL,
      key text NOT NULL,
      request_hash text,
      response_status integer,
      response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

    CREATE TABLE scheduled_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('QUIET_RELEASE','DIGEST')),
      user_id uuid NOT NULL,
      notification_id uuid,
      notification_created_at timestamptz,
      due_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE','CANCELLED','FAILED')),
      attempts integer NOT NULL DEFAULT 0,
      locked_by text,
      locked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX scheduled_due_idx ON scheduled_notifications (due_at) WHERE status = 'PENDING';
    CREATE UNIQUE INDEX scheduled_digest_unique_idx ON scheduled_notifications (user_id, due_at) WHERE kind = 'DIGEST';
    CREATE INDEX scheduled_processing_idx ON scheduled_notifications (locked_at) WHERE status = 'PROCESSING';

    CREATE TABLE digest_suggestions (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      cap_hits integer NOT NULL,
      suggested_frequency text NOT NULL DEFAULT 'WEEKLY',
      suggested_at timestamptz NOT NULL DEFAULT now(),
      dismissed_at timestamptz
    );

    CREATE TABLE analytics_hourly (
      bucket timestamptz NOT NULL,
      channel text NOT NULL,
      event_type text NOT NULL,
      metric text NOT NULL,
      value bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, channel, event_type, metric)
    );
    CREATE TABLE analytics_processed (
      transition_id uuid PRIMARY KEY,
      processed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX analytics_processed_time_idx ON analytics_processed (processed_at);

    CREATE TABLE audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_id text NOT NULL,
      actor_role text NOT NULL,
      action text NOT NULL,
      target_type text NOT NULL,
      target_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      correlation_id text,
      ip_hash text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);
    CREATE INDEX audit_logs_time_idx ON audit_logs (created_at DESC);

    CREATE TABLE principals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('HUMAN','SERVICE')),
      username text NOT NULL UNIQUE,
      secret_hash text NOT NULL,
      roles text[] NOT NULL,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz
    );
    CREATE TABLE refresh_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
      family_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      replaced_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

    -- Creates monthly partitions [month, month+1) for a range of months.
    CREATE OR REPLACE FUNCTION ensure_notification_partitions(months_back integer, months_ahead integer)
    RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE
      m date;
      created integer := 0;
      part text;
    BEGIN
      FOR i IN -months_back..months_ahead LOOP
        -- Month boundaries are computed in UTC so partitioning is independent of the session TimeZone.
        m := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
        part := format('notifications_%s', to_char(m, 'YYYY_MM'));
        IF to_regclass(part) IS NULL THEN
          EXECUTE format('CREATE TABLE %I PARTITION OF notifications FOR VALUES FROM (%L) TO (%L)', part,
            (m::timestamp AT TIME ZONE 'UTC'), ((m + interval '1 month')::timestamp AT TIME ZONE 'UTC'));
          created := created + 1;
        END IF;
      END LOOP;
      RETURN created;
    END $$;
    SELECT ensure_notification_partitions(1, 3);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP FUNCTION IF EXISTS ensure_notification_partitions(integer, integer);
    DROP TABLE IF EXISTS refresh_tokens, principals, audit_logs, analytics_processed, analytics_hourly,
      digest_suggestions, scheduled_notifications, idempotency_records, outbox, webhook_receipts,
      provider_configs, dead_letter_entries, template_versions, templates, policy_decisions,
      delivery_attempts, notification_state_history, notification_keys, notifications,
      financial_events, ingestion_batches, dnd_registry_entries, dnd_registry_imports, opt_out_events,
      consent_records, user_preferences, user_contacts, users CASCADE;
  `);
}
