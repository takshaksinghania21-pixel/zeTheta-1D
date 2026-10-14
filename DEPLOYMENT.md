# Deployment Guide

> **Verification status (2026-10-12).** The Compose stack was built and run on
> Docker Desktop 29.8.2 / Compose v5.5.1 (macOS, arm64): image built (Node
> 20.19.6, non-root, 183 MB unpacked), all 11 long-running services healthy,
> migrations + seed over verified TLS, smoke test 15/15 and 7 additional
> functional checks against the containers, graceful shutdown and a full
> stop/start cycle. PostgreSQL TLS was verified on the Compose PostgreSQL
> (trusted CA accepted; plaintext, untrusted CA and wrong host name rejected). The
> full test suite also ran on Node 20.19.6 in a container against
> `docker-compose.test.yml`. **Not verified:** the GitHub Actions workflow (the
> repository has not been pushed), x86-64 images, and real provider sandboxes.
> Details and commands: docs/IMPLEMENTATION_STATUS.md, Phase 9.

## 1. Prerequisites

| Component  | Version used/pinned                                                                 | Notes                                                                          |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Node.js    | 20.19.6 in Docker/CI (assignment); verified locally on 26.8.2                       | Node 20 reached end-of-life on 2026-04-30 — plan an upgrade to the current LTS |
| PostgreSQL | 16.15                                                                               | `gen_random_uuid()` (core since 13), declarative partitioning                  |
| Redis      | 7.4.11 (compose), 8.10 (verified locally)                                           | `noeviction` policy required (caps/rate limits must not be evicted)            |
| Kafka      | Confluent 7.5.0 + ZooKeeper (compose, PDF Appendix C); 4.3.1 KRaft verified locally | `auto.create.topics.enable=false`; topics created by the app                   |
| RabbitMQ   | 4.3.6                                                                               | classic queues with `x-max-priority`                                           |

## 2. Configuration checklist

Copy `.env.example` → `.env` (or your secret manager) and set:

- [ ] `NODE_ENV=production` — enables fail-safe checks (startup aborts on unsafe config).
- [ ] `JWT_SECRET` (≥ 32 random chars), `DATA_ENCRYPTION_KEY`, `DATA_HASH_KEY` (two **different** 32-byte keys, base64).
- [ ] `WEBHOOK_SIGNING_SECRET` and per-provider webhook secrets (`TWILIO_AUTH_TOKEN`, `WHATSAPP_APP_SECRET`, `MSG91_WEBHOOK_SECRET`).
- [ ] `PROVIDER_MODE=production` (or `sandbox`) and the provider lists, e.g. `SMS_PROVIDERS=twilio,msg91`, `EMAIL_PROVIDERS=smtp`, `PUSH_PROVIDERS=fcm`, `WHATSAPP_PROVIDERS=whatsapp-cloud`, `INAPP_PROVIDERS=socketio`. Any listed provider without credentials aborts startup.
- [ ] `PUBLIC_BASE_URL` (used for Twilio callback URLs/signature validation), `CORS_ORIGINS` (no `*`), `TRUST_PROXY` (hop count behind the load balancer).
- [ ] Connection URLs with TLS where available (`DATABASE_SSL=true`, `amqps://`, `rediss://`, `KAFKA_SSL=true` + SASL).
- [ ] Review `config/notification-policy.yaml` and `config/event-taxonomy.yaml` with compliance (see SECURITY.md §2).
- [ ] PostgreSQL TLS for Compose: run `scripts/dev-certs.sh` once (writes a self-signed
      server certificate to `.local/certs/`, git-ignored). The app verifies it via
      `DATABASE_SSL_CA_FILE`; in production use a CA-issued certificate.

## 3. Database migration procedure

```bash
# compiled image
node dist/src/database/migrate.js latest
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
scripts/dev-certs.sh                  # once; refuses to overwrite an existing certificate
docker compose up -d --build --wait   # full stack; returns when every service is healthy
docker compose ps                     # migrate: Exited (0); everything else (healthy)
curl -fsS localhost:3000/health/ready # {"status":"ready","checks":{...all up}}
```

`.env` must provide `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`
(Compose refuses to start otherwise). To keep them out of `.env`, or when host
ports 5432/6379/9092/15672 are taken by local services, put them in a second
git-ignored file and pass both:
`docker compose --env-file .env --env-file .local/compose.env up -d --build --wait`
(host ports: `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `KAFKA_HOST_PORT`,
`RABBITMQ_MGMT_HOST_PORT`, `APP_HOST_PORT`). With `SEED=true` and the `SEED_*`
passwords set, the `migrate` service also seeds. Smoke test against the stack:
`SEED_CREDENTIALS_FILE=<file with those credentials> npm run smoke`.

`docker compose stop` keeps all data; `docker compose down` removes containers
but keeps the named volumes; only `down -v` deletes data.

Without Docker (verified path): see README §"Run without Docker".

Process roles (scale independently; Compose services `app`, `worker-events`,
`worker-critical`, `worker-dispatch` × 2, `worker-analytics`):

| Role                   | Command                                                                                 | Scaling                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| API                    | `node dist/src/server.js`                                                               | stateless; ≥2 behind a load balancer (Socket.IO uses the Redis adapter; enable sticky sessions or websocket-only transport) |
| Event consumer         | `node dist/src/workers/main.js event-consumer`                                          | ≤ number of `notification-events` partitions                                                                                |
| Critical consumer      | `... critical-consumer`                                                                 | own topic `notification-critical` and consumer group; run separately so bulk traffic cannot delay it                        |
| Dispatcher             | `node dist/src/workers/main.js dispatcher` (`DISPATCH_CHANNELS=sms,push` to specialise) | horizontally; prefetch via `RABBITMQ_PREFETCH`                                                                              |
| Outbox relay           | `... outbox-relay`                                                                      | ≥1 (SKIP LOCKED makes several safe; ordering across relays is not guaranteed)                                               |
| Scheduler              | `... scheduler`                                                                         | ≥1 (SKIP LOCKED; also moves due Redis ZSET retries)                                                                         |
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

Metric names follow PDF §A11.1; the seven §A11.2 alerts are defined in
[`config/prometheus-alerts.yml`](config/prometheus-alerts.yml) (parsed and checked
by `tests/unit/alert-rules.test.ts`; never loaded into a running Prometheus).

| Alert (§A11.2)           | Expression (summary)                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `HighDLQDepth`           | `notification_dlq_depth > 100`                                    |
| `ProviderCircuitOpen`    | `delivery_provider_circuit_state == 2`                            |
| `DeliveryLatencySpike`   | CRITICAL p99 `notification_delivery_latency_seconds` > 30 s (5 m) |
| `HighFailureRate`        | non-success / total `notification_delivery_total` > 5 % (10 m)    |
| `KafkaConsumerLag`       | `sum by (topic, consumer_group) (kafka_consumer_lag) > 10000`     |
| `FrequencyCapExhaustion` | cap hits / accepted events > 50 % for 30 m                        |
| `DNDViolationDetected`   | `notification_dnd_violations > 0`                                 |

Also useful: `outbox_backlog` (broker down / relay stuck),
`notification_retry_queue_depth`, `rabbitmq_queue_depth`,
`webhooks_received_total{outcome="rejected_signature"}`,
`rate_limit_rejections_total`, `events_processed_total{outcome="failed"}`.

Logs are JSON on stdout (ISO timestamp, level, service, component,
correlationId); ship them to your log platform and index `correlationId`.

## 9. Backup and recovery

- PostgreSQL is the source of truth: PITR (WAL archiving) + daily base backups;
  test restores regularly. Old monthly partitions can be detached/archived
  after the retention scrub.
- Redis holds reconstructible short-lived state (caps, circuits, rate limits,
  caches, retry ZSET, real-time counters, engagement features). Losing it resets
  frequency caps for up to 24 h and engagement history — enable AOF. While Redis is
  down, routing fails closed (events are retried, not sent unchecked).
- Kafka retains `notification-events` and `notification-critical` for 7 days,
  `notification-lifecycle` for 3 days and `notification-dlq` for 30 days (replay
  window). RabbitMQ queues are durable; the scheduler's sweep re-enqueues stale
  work if queues are lost. Pending retries live in a Redis ZSET **and** in
  `notifications.next_attempt_at`, so a lost Redis is recovered by the sweep.

## 10. Production-readiness limitations

Not production-ready as delivered. Remaining work:

1. Run the CI workflow on GitHub (never executed — the repository has not been
   pushed); the Compose stack was validated locally on arm64 only.
2. Real provider sandboxes (Twilio test creds, Ethereal, Firebase project,
   Meta test number) were not exercised; adapters were verified against local
   HTTP/SMTP stubs. APNs is not implemented (iOS push goes through FCM).
3. Single-broker Kafka/RabbitMQ only; replication factors, quorum queues, TLS
   and SASL on all hops need production configuration.
4. Load tests were run on one laptop with all roles in one process
   (docs/performance-benchmarks.md); capacity planning for millions of notifications/day is
   an estimate, not a measurement.
5. Compliance assumptions in SECURITY.md §2 need legal sign-off.
