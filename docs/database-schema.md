# Database schema

PostgreSQL 15+ (verified on 16), managed by Knex migrations in
`src/database/migrations/` (`npm run migrate`). The ER diagram is in
[ARCHITECTURE.md §7](../ARCHITECTURE.md#7-data-model-er). This page maps the
implementation to PDF §A5.2 and §A8 and records the query-plan evidence.

## Migrations

| Migration                          | Contents                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `20261011000001_initial_schema`    | All tables, monthly partitioning of `notifications`, `ensure_notification_partitions()`, base indexes |
| `20261012000001_pdf_alignment`     | A8.2 indexes, PDF-named views, DLQ classification column, digest-suggestion count column              |
| `20261012000002_template_ab_tests` | Template A/B experiment columns (`experiment_version`, `experiment_percent`)                          |

## PDF core tables → implementation

The PDF table names exist as read-only views (`notification_state_log`,
`dead_letter_queue`, `delivery_providers`) over the implementation tables, so
queries written against §A8 work unchanged.

| PDF table (§A8 / Day 2)  | Implementation                                | Notes                                                                                    |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `users`                  | `users` + `user_contacts`                     | Phone/email/push tokens are separate encrypted contact rows (AES-256-GCM + blind index)  |
| `notifications`          | `notifications` (+ `notification_keys`)       | One row per (event, channel); `PARTITION BY RANGE (created_at)`, monthly                 |
| `notification_state_log` | `notification_state_history` (view: PDF name) | `from_state/to_state` = `from_status/to_status`; actor, metadata, correlation id, reason |
| `dead_letter_queue`      | `dead_letter_entries` (view: PDF name)        | Adds `source`, `classification`, retry history; status OPEN/RETRIED/RESOLVED/DISCARDED   |
| `user_preferences`       | `user_preferences`                            | One versioned JSON document per user (see below)                                         |
| `templates`              | `templates` + `template_versions`             | Versioned; `active_version` and A/B `experiment_version`/`experiment_percent`            |
| `delivery_providers`     | `provider_configs` (view: PDF name)           | Credentials stay in the environment / secret manager                                     |
| `consent_records`        | `consent_records`                             | Append-only ledger (latest record per channel/purpose wins)                              |

Additional tables: `financial_events`, `ingestion_batches`, `delivery_attempts`,
`policy_decisions` (every routing/dispatch decision, incl. DND checks with
timestamps), `dnd_registry_imports`/`dnd_registry_entries`, `opt_out_events`,
`outbox`, `webhook_receipts`, `scheduled_notifications`, `digest_suggestions`,
`analytics_hourly`/`analytics_processed`, `idempotency_records`, `audit_logs`,
`principals`, `refresh_tokens`.

### `notifications` column mapping (§A8.1)

| PDF column                        | Implementation                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `id` (PK)                         | `id` — PK is `(id, created_at)` (partition key rule)                                      |
| `event_type`, `user_id`           | same                                                                                      |
| `event_id` (external ref)         | `event_id` → `financial_events.id`; external id/key in `financial_events.idempotency_key` |
| `channel`                         | same (`inapp` = PDF `in_app`)                                                             |
| `priority` INTEGER 1–5            | `priority` text CRITICAL/HIGH/MEDIUM/LOW (API exposes 1/2/3/5)                            |
| `status`                          | `state`                                                                                   |
| `template_id`, `template_version` | `template_version` (+ `content.templateId`); API `template_id` = `<event>-v<version>`     |
| `personalisation_data` JSONB      | `financial_events.payload` (scrubbed after 90 days)                                       |
| `rendered_content` JSONB          | `content`                                                                                 |
| `provider`, `external_id`         | `provider`, `provider_message_id`                                                         |
| `delivery_attempts`               | `attempt_count` (+ `delivery_attempts` table)                                             |
| `max_retries`, `next_retry_at`    | `max_retries`, `next_attempt_at`                                                          |
| `delivered_at`, `read_at`         | same (+ `sent_at`, `clicked_at`, `failed_at`)                                             |
| `failed_reason`                   | `last_error_code`, `last_error_message`                                                   |
| `cost_paisa`                      | `cost_micros` (micro-INR; API exposes `cost_paisa`)                                       |
| `metadata`, timestamps            | `created_at`, `updated_at`, `scrubbed_at`, `correlation_id`                               |

### `user_preferences` (§A5.2)

The PDF row model (`user_id, event_category, event_type, channel, enabled,
quiet_hours_override, digest_mode, priority_override`) is stored as one versioned
JSON document per user: `channels`, `categories` (enabled + channel subset),
`digest`, `quietHours`, `timezone`, `locale`. A single row gives optimistic
concurrency (`If-Match`) and an atomic read-modify-write; the four-layer hierarchy
is resolved in `src/preferences/resolver.ts`. The PDF's
`PRIMARY KEY (…, COALESCE(event_type,'*'), …)` is not valid SQL (see the README
Document Error Log).

## Indexes (§A8.2)

| Required                                  | Index                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Composite `(user_id, status, channel)`    | `notifications_user_status_channel_idx (user_id, state, channel)`                        |
| Partial `status IN ('QUEUED','RETRYING')` | `notifications_worker_idx (state, next_attempt_at) WHERE state IN ('QUEUED','RETRYING')` |
| BRIN on `created_at`                      | `notifications_created_brin_idx USING brin (created_at)`                                 |
| GIN on personalisation data               | `financial_events_payload_gin_idx USING gin (payload jsonb_path_ops)`                    |
| `(event_type, created_at)`                | `notifications_event_type_created_idx`                                                   |

Also: `(user_id, created_at DESC, id DESC)` for paginated inboxes,
`(created_at, channel, event_type)` for analytics, `event_id`, provider message id,
partial indexes on the outbox, DLQ, scheduled jobs and pending attempts.

## Partitioning

`notifications` is range-partitioned by month (UTC-aligned) with a DEFAULT
partition as a safety net; `ensure_notification_partitions(back, ahead)` runs in the
migration and every 6 h in the scheduler (1 month back, 3 ahead). Monthly
partitions keep time-range analytics and retention scrubbing to a few partitions and
let old months be detached/archived cheaply.

## Query plans (EXPLAIN ANALYZE)

`npm run explain` writes [`reports/explain-delivery-rate.txt`](../reports/explain-delivery-rate.txt).
Latest run: 180 724 notifications in one month partition, PostgreSQL 16, laptop.

| Query                                                 | Plan                                                                                | Time    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ------- |
| Daily delivery rate by channel (raw table)            | partition pruning + sequential scan of the current month (the day covers ~all rows) | 132 ms  |
| Same report from `analytics_hourly` (CQRS read model) | index/seq scan of 116 aggregate rows                                                | 0.24 ms |
| Last 15 minutes by channel                            | index-only scan on `(created_at, channel, event_type)`                              | 8.6 ms  |
| Per-user list (user, state, channel)                  | index scans on the user indexes                                                     | 0.09 ms |
| One event type for a day (~30 % of rows)              | parallel sequential scan (index not selective enough)                               | 36 ms   |

Reading: dashboards and the daily report read the hourly aggregate maintained by
the analytics consumer, not the raw table. The BRIN index exists as required, but
at this volume the planner prefers the covering B-tree for time ranges; BRIN pays
off on much larger append-only partitions. At 30-day volume (~60 M rows at 2 M/day)
the raw daily report would scan one day's worth of a ~60 M-row partition, which is
why the aggregate is the supported path. These are single-machine numbers.
