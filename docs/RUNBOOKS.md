# Operational Runbooks

All endpoints require an OPERATOR or ADMIN token unless stated. Every response
carries `X-Correlation-Id`; search logs by `correlationId` to follow a request
through Kafka, RabbitMQ, workers and webhooks.

## Quick diagnostics

```bash
curl -s localhost:3000/health/ready
```

```bash
curl -s localhost:3000/api/v1/ops/queues -H "authorization: Bearer $OPS"
```

```bash
curl -s localhost:3000/api/v1/ops/providers -H "authorization: Bearer $OPS"
```

`ops/queues` returns RabbitMQ depth/consumers per queue, Kafka consumer lag,
outbox backlog, open DLQ entries and pending scheduled jobs.

## RB-1 Events accepted but not processed (`status: RECEIVED`)

1. `outboxBacklog` growing → outbox relay not running or Kafka unavailable.
   Check `outbox.last_error`: `SELECT id, attempts, last_error FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 20;`
2. Backlog 0 but Kafka lag growing → event-consumer down or failing; look for
   `retryable event failure` in logs (offsets are not committed until the DB
   transaction succeeds, so the consumer retries automatically).
3. Event `FAILED` → see `status_reason` and the DLQ (`source=EVENT`); fix the
   cause (e.g. schema change) and `POST /api/v1/dlq/{id}/retry`.

## RB-2 Notifications stuck in QUEUED / RETRYING

1. `rabbitmq.<prefix>delivery.<channel>.consumers == 0` → start a dispatcher.
2. Messages present but not consumed → check dispatcher logs for lock
   contention (`requeue`) or DB errors.
3. Lost messages (e.g. queue deleted): the scheduler sweeper re-enqueues
   notifications stale for `RETRY_SWEEP_STALE_SECONDS` (default 300 s).
   Duplicates are ignored by the dispatcher.

## RB-3 Provider outage / circuit open

1. `GET /ops/providers` → `circuit.status: OPEN`.
2. Traffic fails over to the next provider of the channel automatically; if
   all are down, notifications go `RETRYING` (delay ≥ circuit cool-down) and
   eventually `DLQ` + fallback channel.
3. Disable a provider: `PATCH /api/v1/ops/providers/{name} {"enabled": false}` (ADMIN).
4. After recovery: `PATCH … {"resetCircuit": true}` or wait for the half-open trial.

## RB-4 DLQ handling

```bash
curl -s "localhost:3000/api/v1/dlq?status=OPEN" -H "authorization: Bearer $OPS"
```

```bash
curl -s localhost:3000/api/v1/dlq/{id} -H "authorization: Bearer $OPS"
```

- Retry (OPERATOR/ADMIN): `POST /api/v1/dlq/{id}/retry {"note": "..."}` — fresh
  retry budget; the original retry counter is kept for duplicate detection.
- Resolve (handled elsewhere): `POST /api/v1/dlq/{id}/resolve {"resolution":"RESOLVED","note":"..."}`
- Discard (ADMIN only): `{"resolution":"DISCARDED"}` → notification `FAILED`.
- `POISON` entries (unparseable messages) cannot be retried; inspect `payload`.
  All actions are written to `audit_logs`.

## RB-5 Webhook signature failures

`webhooks_received_total{outcome="rejected_signature"}` increasing:
verify the provider secret (`WEBHOOK_SIGNING_SECRET`, `TWILIO_AUTH_TOKEN`,
`WHATSAPP_APP_SECRET`, `MSG91_WEBHOOK_SECRET`), `PUBLIC_BASE_URL` (Twilio signs
the full URL), clock skew (> `WEBHOOK_TOLERANCE_SECONDS`), and that a proxy is
not re-encoding the body. Never disable verification in production (it cannot
be disabled: the config forces it).

## RB-6 Users not receiving notifications

1. `GET /api/v1/events/{eventId}` → notifications and decisions.
2. Typical decisions: `PREFERENCE_CHANNEL_DISABLED`, `CONSENT_REVOKED`,
   `WHATSAPP_OPT_IN_REQUIRED`, `DND_*`, `QUIET_HOURS_DEFER`,
   `FREQUENCY_CAP_*`, `NO_CONTACT`, `CONTACT_INVALID`.
3. Dry run without side effects: `POST /api/v1/compliance/evaluate {"userId": "...", "eventType": "..."}`.
4. `MANDATORY_UNDELIVERABLE` → a mandatory event reached no mandatory channel;
   contact the customer through another route.

## RB-7 Quiet-hours releases / digests not sent

`SELECT kind, status, count(*) FROM scheduled_notifications GROUP BY 1,2;`
`PENDING` with past `due_at` → scheduler not running. `FAILED` → see
`last_error` (job retried up to 5 times). Stuck `PROCESSING` rows are reclaimed
by the sweeper after `RETRY_SWEEP_STALE_SECONDS`.

## RB-8 Kafka replay / recovery

Processing is idempotent, so replaying is safe:

```bash
kafka-consumer-groups --bootstrap-server localhost:9092 --group zetheta.notification-engine.event-consumer --topic zetheta.financial-events.v1 --reset-offsets --to-datetime 2026-01-15T00:00:00.000 --execute
```

(Stop event consumers first.) Already-`PROCESSED` events are skipped; the
analytics consumer de-duplicates by transition id.

## RB-9 Partition maintenance

Monthly partitions are created 3 months ahead by the scheduler. If rows land in
`notifications_default`, run `SELECT ensure_notification_partitions(1, 6);` and
move rows (detach default, insert into the new partition) during a quiet period.

## RB-10 Data subject requests and retention

- Erasure: `POST /api/v1/users/{id}/anonymize {"reason": "..."}` (ADMIN, audited).
- Retention runs daily; on demand: `POST /api/v1/ops/retention/run` (ADMIN).

## RB-11 Mock-mode failure drills (non-production)

```bash
curl -s -X POST localhost:3000/api/v1/ops/providers/mock-sms-primary/simulate \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"mode":"fail_transient","remaining":5}'
```

Modes: `ok`, `fail_transient`, `fail_permanent`, `timeout`, `rate_limited`,
`invalid_recipient`, `auth_error`. Disabled outside `PROVIDER_MODE=mock`.
