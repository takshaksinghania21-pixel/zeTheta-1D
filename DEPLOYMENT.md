# Deployment Guide

> **Verification status.** The application, migrations, workers and full test
> suite were verified against locally installed PostgreSQL 16, Redis 8, Kafka 4.3
> and RabbitMQ 4.3 (macOS host). **Docker was not available on the authoring
> machine**, so `Dockerfile`, `docker-compose.yml` and `docker-compose.test.yml`
> are written and statically validated (YAML parses, services/images pinned) but
> were **not built or started**. The CI workflow builds the image on every push.

## 1. Prerequisites

| Component  | Version used/pinned                                           | Notes                                                                          |
| ---------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Node.js    | 20.19.6 in Docker/CI (assignment); verified locally on 26.8.2 | Node 20 reached end-of-life on 2026-04-30 — plan an upgrade to the current LTS |
| PostgreSQL | 16.15                                                         | `gen_random_uuid()` (core since 13), declarative partitioning                  |
| Redis      | 7.4.11 (compose), 8.10 (verified locally)                     | `noeviction` policy required (caps/rate limits must not be evicted)            |
| Kafka      | 4.3.1 (KRaft, no ZooKeeper)                                   | `auto.create.topics.enable=false`; topics created by the app                   |
| RabbitMQ   | 4.3.6                                                         | classic queues with `x-max-priority`                                           |

## 2. Configuration checklist

Copy `.env.example` → `.env` (or your secret manager) and set:

- [ ] `NODE_ENV=production` — enables fail-safe checks (startup aborts on unsafe config).
- [ ] `JWT_SECRET` (≥ 32 random chars), `DATA_ENCRYPTION_KEY`, `DATA_HASH_KEY` (two **different** 32-byte keys, base64).
- [ ] `WEBHOOK_SIGNING_SECRET` and per-provider webhook secrets (`TWILIO_AUTH_TOKEN`, `WHATSAPP_APP_SECRET`, `MSG91_WEBHOOK_SECRET`).
- [ ] `PROVIDER_MODE=production` (or `sandbox`) and the provider lists, e.g. `SMS_PROVIDERS=twilio,msg91`, `EMAIL_PROVIDERS=smtp`, `PUSH_PROVIDERS=fcm`, `WHATSAPP_PROVIDERS=whatsapp-cloud`, `INAPP_PROVIDERS=socketio`. Any listed provider without credentials aborts startup.
- [ ] `PUBLIC_BASE_URL` (used for Twilio callback URLs/signature validation), `CORS_ORIGINS` (no `*`), `TRUST_PROXY` (hop count behind the load balancer).
- [ ] Connection URLs with TLS where available (`DATABASE_SSL=true`, `amqps://`, `rediss://`, `KAFKA_SSL=true` + SASL).
- [ ] Review `config/notification-policy.yaml` and `config/event-taxonomy.yaml` with compliance (see SECURITY.md §2).

## 3. Database migration procedure

```bash
# compiled image
node dist/src/infrastructure/database/migrate.js latest
# from source
npm run migrate
```

Migrations are recorded without file extension so source (`.ts`) and compiled
(`.js`) runs share history. Run migrations as a one-off job **before** rolling
out new application versions (compose: the `migrate` service). Partitions for
the next 3 months are created by the migration and maintained by the scheduler
every 6 hours; alert if `notifications_default` receives rows.

## 4. Starting the services

```bash
docker compose up -d --build          # full stack (unverified locally, see banner)
docker compose ps                     # all services healthy?
curl -fsS localhost:3000/health/ready # {"status":"ready","checks":{...all up}}
```

Without Docker (verified path): see README §"Run without Docker".

Process roles (scale independently):

| Role                   | Command                                                                                 | Scaling                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| API                    | `node dist/src/server.js`                                                               | stateless; ≥2 behind a load balancer (Socket.IO uses the Redis adapter; enable sticky sessions or websocket-only transport) |
| Event consumer         | `node dist/src/workers/main.js event-consumer`                                          | ≤ number of `financial-events.v1` partitions                                                                                |
| Dispatcher             | `node dist/src/workers/main.js dispatcher` (`DISPATCH_CHANNELS=sms,push` to specialise) | horizontally; prefetch via `RABBITMQ_PREFETCH`                                                                              |
| Outbox relay           | `... outbox-relay`                                                                      | ≥1 (SKIP LOCKED makes several safe; ordering across relays is not guaranteed)                                               |
| Scheduler              | `... scheduler`                                                                         | ≥1 (SKIP LOCKED)                                                                                                            |
| Analytics / DLQ ingest | `... analytics`, `... dlq-ingest`                                                       | 1–2                                                                                                                         |

## 5. Secrets management

- Never bake secrets into images or commit `.env`; `.dockerignore` excludes it.
- Provide secrets via the orchestrator's secret store (Kubernetes Secrets backed
  by a KMS, AWS Secrets Manager, Vault…).
- Rotate `DATA_ENCRYPTION_KEY` by deploying a new key id (`DATA_ENCRYPTION_KEY_ID`)
  and keeping the old key available to `FieldEncryptor` for decryption (code
  supports retired keys; wiring them from config is a follow-up).
- Rotating `JWT_SECRET` invalidates all access tokens (15 min impact) and
  refresh tokens are unaffected (opaque, DB-backed).

## 6. Health verification

- `GET /health/live` — process up. `GET /health/ready` — PostgreSQL, Redis,
  RabbitMQ and Kafka reachable (503 otherwise, and during shutdown drain).
- Workers expose the same endpoints on `METRICS_PORT` (default 9464).
- Post-deploy smoke test (mock/sandbox environments): `npm run smoke`.

## 7. Rollback considerations

- Application rollback: redeploy the previous image; the schema is additive.
- Schema rollback: `npm run migrate:rollback` drops the initial schema — **data
  loss**; only for disposable environments. Write forward-fix migrations in
  production.
- In-flight messages are compatible across versions as long as
  `DeliveryMessage` and `KafkaEventMessage` (`schemaVersion: 1`) stay
  backward-compatible.

## 8. Monitoring and alerts

Prometheus metrics (selection) and suggested alerts:

| Metric                                                  | Alert                                              |
| ------------------------------------------------------- | -------------------------------------------------- |
| `dlq_open_entries`                                      | > 0 for 15 min (page for CRITICAL channel entries) |
| `kafka_consumer_lag{group=…event-consumer}`             | > 1000 for 5 min                                   |
| `outbox_backlog`                                        | > 500 for 5 min (broker down / relay stuck)        |
| `provider_circuit_state`                                | == 2 (open) for 5 min                              |
| `rabbitmq_queue_depth{queue=…delivery.sms}`             | growing for 10 min                                 |
| `notification_send_latency_seconds` (p95, CRITICAL)     | > latency objective (10 s for margin calls)        |
| `webhooks_received_total{outcome="rejected_signature"}` | rate > 0 (misconfiguration or attack)              |
| `rate_limit_rejections_total`                           | sudden spikes                                      |
| `frequency_cap_hits_total`                              | trend review                                       |
| `events_processed_total{outcome="failed"}`              | > 0                                                |

Logs are JSON on stdout (ISO timestamp, level, service, component,
correlationId); ship them to your log platform and index `correlationId`.

## 9. Backup and recovery

- PostgreSQL is the source of truth: PITR (WAL archiving) + daily base backups;
  test restores regularly. Old monthly partitions can be detached/archived
  after the retention scrub.
- Redis holds reconstructible short-lived state (caps, circuits, rate limits,
  caches). Losing it resets frequency caps for up to 24 h — acceptable but
  enable AOF to avoid it.
- Kafka retains `financial-events.v1` for 7 days, `notification-lifecycle.v1`
  for 3 days (replay window). RabbitMQ queues are durable; the sweeper
  re-enqueues stale work if queues are lost.

## 10. Production-readiness limitations

Not production-ready as delivered. Remaining work:

1. Build and run the Docker images; run the CI workflow on GitHub (never
   executed — no remote repository was created).
2. Real provider sandboxes (Twilio test creds, Ethereal, Firebase project,
   Meta test number) were not exercised; adapters were verified against local
   HTTP/SMTP stubs.
3. Single-broker Kafka/RabbitMQ only; replication factors, quorum queues, TLS
   and SASL on all hops need production configuration.
4. Load tests were run on one laptop with all roles in one process
   (docs/PERFORMANCE.md); capacity planning for millions of notifications/day is
   an estimate, not a measurement.
5. Compliance assumptions in SECURITY.md §2 need legal sign-off.
