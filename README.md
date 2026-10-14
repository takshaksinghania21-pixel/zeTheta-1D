# Zetheta BE-6B — Event-Driven Notification Engine

An event-driven backend that turns financial events (trades, margin calls, SIPs,
market alerts, regulatory notices) into compliant, personalised notifications
across **SMS, email, push, WhatsApp and in-app**, with durable asynchronous
processing, retries, a dead-letter queue, analytics and an operator API.

> **Status.** Implemented and verified locally against real PostgreSQL, Redis,
> Kafka and RabbitMQ, and as a Docker Compose deployment (Docker Desktop 29.8,
> Node 20.19.6 image; see [Verification](#verification-summary)). The GitHub
> Actions workflow has **not run** (no remote repository) and provider adapters
> were exercised against local stubs and mocks only. Not production-ready — see
> [Known limitations](#known-limitations).
>
> The assignment PDF was audited requirement by requirement:
> [docs/TRACEABILITY.md](docs/TRACEABILITY.md) ·
> [docs/FINAL_GAP_ANALYSIS.md](docs/FINAL_GAP_ANALYSIS.md) ·
> [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Key features

- **25 financial event types** in five categories (PDF §A2) defined in
  [`config/event-taxonomy.yaml`](config/event-taxonomy.yaml) (copies at
  `docs/event-taxonomy.yaml` and `src/events/taxonomy.yaml`) and compiled to strict
  schemas; urgency, channels, latency objectives and SEBI/exchange-mandated
  channels follow the PDF; every event is TRANSACTIONAL or PROMOTIONAL.
- **Pipeline:** REST ingestion (native or PDF Appendix A contract) → idempotency
  and storm dedup → transactional outbox → Kafka (`notification-events`, CRITICAL
  on `notification-critical` with its own consumer group) → enrichment →
  preferences/consent → engagement & cost optimisation → quiet hours → frequency
  caps → templates (A/B variants) → RabbitMQ priority queues → **DND re-check at
  dispatch** → provider adapters → signed receipts → analytics.
- **Routing (PDF §A3.2):** regulatory override → user preferences → delivery
  optimisation from per-user engagement history (Redis feature store) → cost
  optimisation with per-user day/month budgets.
- **Compliance:** consent ledger (separate WhatsApp opt-in), DND registry with a
  24-hour freshness rule, dispatch-time DND decisions persisted as audit proof, DND
  violation self-audit gauge and alert.
- **Frequency caps** (Redis Lua, atomic, idempotent): 12/day global, SMS 5, push
  8, email 3, 3/hour per category, 15-minute same-type cooldown (configurable per
  event), digest suggestion above 8/day over 7 days.
- **Quiet hours** per IANA timezone (DST-safe, ≥ 6 h), CRITICAL bypass with audit,
  durable deferral, morning digest when > 5 notifications were deferred.
- **Templates:** Handlebars sandbox, 5 locales (en, hi, mr, ta, te), channel
  formats, versioning with deterministic A/B experiments, preview, SMS ≤ 160
  characters with ellipsis + link, safe HTML email.
- **Delivery:** Twilio + MSG91 (SMS), Nodemailer SMTP, FCM HTTP v1, WhatsApp Cloud
  API, Socket.IO in-app, mock providers with failure injection. Failover, circuit
  breakers (5 failures / 60 s, 60 s open), provider rate limits with a reserved
  share for CRITICAL traffic, timeouts, error classification.
- **Retries/DLQ:** per-priority exponential backoff with jitter scheduled in a
  **Redis sorted set** (PDF Day 9), durable state in PostgreSQL, DLQ with
  automated classification (transient / permanent / configuration) and operator
  retry/resolve/discard; manual-call escalation for undeliverable margin calls.
- **Security:** JWT + refresh rotation, RBAC (ADMIN/OPERATOR/SERVICE/USER), Zod
  strict validation, Redis sliding-window rate limits, webhook signatures,
  AES-256-GCM contact encryption, PII-masked logs (`+91XXXX1234`,
  `s***@domain.com`), audit log, 90-day retention, anonymisation.
- **Observability:** JSON logs (`timestamp, level, message, correlation_id,
service_name`), Prometheus `/metrics` with the §A11.1 metric names, the seven
  §A11.2 alert rules ([`config/prometheus-alerts.yml`](config/prometheus-alerts.yml)),
  `/health`, OpenAPI 3.0 + Swagger UI at `/api-docs`, Postman collection.

## Architecture summary

```
POST /api/v1/events ─► PostgreSQL (event + outbox) ─► relay ─► Kafka notification-events
                                                                 │      notification-critical
                                  event-consumer / critical-consumer ◄─┘
                                          │ routing · compliance · caps · quiet hours · templates
                                          ▼
                       PostgreSQL (notifications, history, decisions, outbox)
                                          │ relay
                                          ▼
                           RabbitMQ delivery.<channel> (priority queues)
                                          │
              dispatcher ─ DND re-check ─┴─► providers ─► webhooks ─► DELIVERED/READ
                  │ transient failure                          │
                  ▼                                            ▼
        Redis ZSET retry schedule              lifecycle events ─► Kafka ─► analytics
                                                               (PostgreSQL aggregates + Redis counters)
```

C4 views, the §E2 source layout and component map: [docs/architecture.md](docs/architecture.md).
Sequence diagrams: [docs/sequence-diagrams/](docs/sequence-diagrams/). Data model:
[docs/database-schema.md](docs/database-schema.md). Design decisions and failure
handling: [ARCHITECTURE.md](ARCHITECTURE.md).

## Technology stack

| Concern            | Choice (pinned in `package.json`)                                                          |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Runtime / language | Node.js 20 LTS (Docker/CI), TypeScript 5.9 strict                                          |
| HTTP               | Express 5, Helmet, CORS, Zod 4, zod-to-openapi, swagger-ui-express                         |
| Data               | PostgreSQL 15+ (verified on 16) via Knex 3 (+ pg), Redis 7+ via ioredis                    |
| Messaging          | Kafka (Confluent 7.5 in Compose; Apache 4.3 locally) via kafkajs, RabbitMQ 3.12+ (amqplib) |
| Templates          | Handlebars 4.7.10, Luxon (time zones)                                                      |
| Providers          | Twilio REST, MSG91 Flow API, Nodemailer 10, FCM HTTP v1, WhatsApp Cloud API, Socket.IO 4   |
| Observability      | pino, prom-client                                                                          |
| Tests              | Jest 30 (`jest.config.ts`, ts-node), ts-jest, Supertest, socket.io-client, smtp-server     |
| Load               | k6 ([`tests/load/`](tests/load/))                                                          |
| Delivery           | Docker (multi-stage, Alpine), Docker Compose, GitHub Actions                               |

## Prerequisites

- Node.js ≥ 20.11 (local verification used 26.8.2; Docker/CI use 20.19.6 as the
  assignment requires — Node 20 reached end-of-life on 2026-04-30).
- PostgreSQL 15+, Redis 7+, Kafka, RabbitMQ 3.12+ — via Docker Compose or local installs.
- Optional: k6 (load tests), openssl (Compose TLS certificate).

## Local installation

```bash
npm ci
```

```bash
cp .env.example .env        # then replace every CHANGE_ME value
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Start infrastructure — Docker (verified)

```bash
scripts/dev-certs.sh
```

```bash
docker compose up -d postgres redis zookeeper kafka rabbitmq
```

### Start infrastructure — without Docker (verified)

With PostgreSQL and Redis running locally (e.g. `brew services start postgresql@16 redis`),
create the databases, then start Kafka (KRaft) and RabbitMQ as project-local
processes (data under `.local/`):

```bash
createdb zetheta && createdb zetheta_test
```

```bash
npm run infra:local -- start
```

## Database setup, migrations and seeds

```bash
npm run migrate          # applies migrations (DATABASE_URL)
```

```bash
npm run seed             # templates, principals, demo users + 1 000 synthetic users, DND fixtures
```

The seed is idempotent and writes generated credentials to
`.local/seed-credentials.json` (git-ignored, mode 0600): `admin`/`operator`
(password grant), `trading-platform` (client credentials, SERVICE role) and demo
end user `asha`. `SEED_BULK_USERS` changes the synthetic user count.

Simulated datasets for PDF §B4 (100 000 events, 10 000 profiles, 5 000 failures,
2 000 complaints; deterministic, exact distributions) are generated on demand:

```bash
npm run datasets         # writes data/simulated/*.csv (git-ignored, ~30 MB)
```

## Starting the API and workers

Single process (development):

```bash
RUN_WORKERS=all npm run dev:api
```

Separate processes (production-like):

```bash
npm run build
```

```bash
node dist/src/server.js
```

```bash
node dist/src/workers/main.js outbox-relay,event-consumer,scheduler,dlq-ingest
```

```bash
node dist/src/workers/main.js critical-consumer,outbox-relay
```

```bash
node dist/src/workers/main.js dispatcher
```

```bash
node dist/src/workers/main.js analytics
```

Workers serve `/health/live`, `/health/ready` and `/metrics` on `METRICS_PORT`;
the API also serves `/health` (all dependencies and providers).

## API documentation

- Swagger UI: <http://localhost:3000/api-docs> (also `/api/docs`)
- OpenAPI 3.0: <http://localhost:3000/api/v1/openapi.json>,
  [`docs/api-specification.yaml`](docs/api-specification.yaml) and
  [`docs/openapi.json`](docs/openapi.json) (`npm run openapi:generate`)
- Postman: [`docs/postman/zetheta-notification-engine.postman_collection.json`](docs/postman/zetheta-notification-engine.postman_collection.json) (`npm run postman:generate`)

The spec is generated from the same route definitions that register the Express
handlers; outside production every response is validated against its schema.

### PDF Appendix A contracts

The PDF's snake*case request/response shapes are supported alongside the native
camelCase API: `POST /api/v1/events` with the Appendix A envelope (answered with
`notification_id`, `channels_targeted`, `estimated_delivery_ms`, and
`VALIDATION_FAILED` 422 errors), `GET`/`PUT /api/v1/users/:userId/preferences`,
`GET /api/v1/analytics/delivery-rates?period=7d&channel=all`, and
`GET /api/v1/notifications/:notificationId` with `state_history` and the
`compliance` evidence block. `usr*`-prefixed user ids are accepted.

### Example requests

```bash
TOKEN=$(curl -s localhost:3000/api/v1/auth/token -H 'content-type: application/json' \
  -d '{"grantType":"client_credentials","clientId":"trading-platform","clientSecret":"<from .local/seed-credentials.json>"}' | jq -r .accessToken)
```

```bash
curl -s localhost:3000/api/v1/events -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "event_type": "RISK-001", "event_id": "EVT-2099-03-19-MC-1", "source_system": "margin_engine",
  "timestamp": "2099-03-19T10:15:23.456Z", "priority": 1, "user_id": "usr_<user uuid>",
  "payload": { "shortfall_amount": 125000.00, "current_margin": 375000.00, "required_margin": 500000.00,
               "deadline": "2099-03-19T11:30:00.000Z",
               "affected_positions": [{ "symbol": "RELIANCE", "qty": 500, "current_value": 620000.00 }],
               "auto_square_off_time": "2099-03-19T12:00:00.000Z" },
  "idempotency_key": "margin-call-usr_a1b2c3d4-2099-03-19T10:15" }'
```

```bash
curl -s localhost:3000/api/v1/events/<notification_id> -H "authorization: Bearer $TOKEN"
```

Other useful endpoints: `GET /api/v1/notifications/{id}`,
`PUT /api/v1/users/{id}/preferences`, `POST /api/v1/compliance/evaluate` (dry run),
`GET /api/v1/dlq?classification=TRANSIENT`, `POST /api/v1/dlq/{id}/retry`,
`GET /api/v1/analytics/realtime`, `GET /api/v1/analytics/channel-performance`,
`POST /api/v1/templates/{id}/experiment`,
`POST /api/v1/ops/providers/mock-push/simulate` (mock mode only).

## Provider sandbox configuration

`PROVIDER_MODE=mock` (default) uses deterministic simulators; set
`MOCK_RECEIPT_CALLBACK_URL=http://localhost:3000/api/v1/webhooks/mock` to receive
signed delivery receipts. For sandboxes, list real providers per channel and set
their credentials (`.env.example`):

| Channel  | Provider name     | Sandbox                                                                            |
| -------- | ----------------- | ---------------------------------------------------------------------------------- |
| SMS      | `twilio`, `msg91` | Twilio test credentials / magic numbers; MSG91 needs a DLT flow with `##message##` |
| Email    | `smtp`            | Ethereal (`SMTP_HOST=smtp.ethereal.email`, port 587) or a local SMTP catcher       |
| Push     | `fcm`             | Firebase project service account (`FCM_*`, private key base64)                     |
| WhatsApp | `whatsapp-cloud`  | Meta test phone number + temporary access token                                    |
| In-app   | `socketio`        | built in; clients connect to `/socket.io` with a USER token                        |

Real providers were verified against local HTTP/SMTP stubs only; no sandbox
account was used and no real message was sent. APNs direct failover is not
implemented (see [docs/FINAL_GAP_ANALYSIS.md](docs/FINAL_GAP_ANALYSIS.md)).

## Running tests

```bash
npm run test:unit          # no infrastructure needed
```

```bash
npm run test:integration   # needs PostgreSQL (zetheta_test), Redis DB 6, Kafka, RabbitMQ
```

```bash
npm run test:e2e           # full pipeline with all workers in-process
```

```bash
npm run test:coverage      # everything + 80% thresholds on all four metrics
```

```bash
npm run smoke              # functional smoke test against a running stack
```

Integration tests use `zetheta_test`, Redis DB 6 and per-run Kafka/RabbitMQ name
prefixes; they never touch development data. Override with `TEST_DATABASE_URL`,
`TEST_REDIS_URL`, `TEST_KAFKA_BROKERS`, `TEST_RABBITMQ_URL`. Load tests and their
results: [docs/performance-benchmarks.md](docs/performance-benchmarks.md).

## Verification summary

Latest numbers and commands: [docs/TESTING.md](docs/TESTING.md) and
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

| Check                                                                      | Result                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Unit + integration + e2e tests, coverage ≥ 80 % (all four metrics)         | 379/379 pass, branches 80.67 % (Node 26, 2026-10-12)          |
| Smoke test against the compiled build (mock providers)                     | 15/15                                                         |
| ESLint (strict type-checked), Prettier, `tsc --noEmit`, `npm run build`    | pass                                                          |
| Load scenarios normal / 10× / 20× / market crash / critical isolation      | single laptop — [performance](docs/performance-benchmarks.md) |
| PostgreSQL TLS (app verifies server certificate)                           | verified against a throwaway local cluster                    |
| Docker image (Node 20.19.6, non-root, 183 MB) + Compose stack, all healthy | built and run; smoke 15/15 against the containers             |
| PostgreSQL TLS in Compose (plaintext / untrusted CA rejected)              | verified                                                      |
| GitHub Actions CI / real provider sandboxes                                | **not executed** (see DEPLOYMENT.md)                          |

## Troubleshooting

See [docs/RUNBOOKS.md](docs/RUNBOOKS.md). Quick checks:

- `GET /health` shows which dependency or provider circuit is down.
- Events stuck in `RECEIVED`: outbox relay not running or Kafka down
  (`GET /api/v1/ops/queues` → `outboxBacklog`).
- Margin calls not processed: the `critical-consumer` worker is not running.
- Notifications stuck in `QUEUED`: no dispatcher consuming (`consumers == 0`).
- Notifications in `RETRYING` with `LOCAL_RATE_LIMIT`: provider quota exhausted —
  they wait for quota without spending their retry budget.
- `401 Invalid webhook signature`: wrong secret or clock skew > 300 s.
- Everything `QUIET` at night: quiet hours are working — check the user timezone.

## Security considerations

Summary in [SECURITY.md](SECURITY.md): RBAC, token rotation, encryption at rest,
PII masking, webhook verification, rate limiting, TLS to PostgreSQL, audit logs,
and the **compliance assumptions that require legal review**.

## Known limitations

- GitHub Actions has not run (no remote repository). Docker/Compose were
  validated on Docker Desktop for macOS (arm64) only.
- Provider adapters verified against stubs, not real sandbox accounts.
- Delivery is at-least-once: a crash during a provider call can produce a
  duplicate message (ARCHITECTURE.md §9).
- Benchmarks come from one laptop running everything in one process; they are
  not production capacity claims (see the 10× / 20× backlog results).
- Template translations are machine-assisted and need native-speaker review;
  TRANSACTIONAL/PROMOTIONAL classification and cap exemptions need compliance review.
- Email open/click tracking and FCM delivery receipts are not available
  (reported as `null`, never estimated).
- The repository layout follows PDF §E2; Kafka/RabbitMQ/Redis adapters and workers
  live in the additional `src/infrastructure/` and `src/workers/` directories.

## Document Error Log

PDF §A13 states the brief contains five deliberate errors. Candidates found while
implementing, with the handling chosen (confidence in brackets):

1. **Partitioned primary key (§A8.1, p.17) [high].** `notifications.id UUID PRIMARY
KEY` on a table `PARTITION BY RANGE (created_at)` is invalid in PostgreSQL —
   unique constraints on a partitioned table must include the partition key — and
   so `dead_letter_queue.notification_id REFERENCES notifications(id)` cannot exist.
   Implemented as `PRIMARY KEY (id, created_at)`, with logical de-duplication in
   `notification_keys`.
2. **Expression in a primary key (§A5.2, p.13) [high].** `PRIMARY KEY (user_id,
event_category, COALESCE(event_type,'*'), channel)` is not valid SQL; it needs a
   unique expression index. Preferences are stored as one versioned document per
   user (optimistic concurrency) instead.
3. **Retry examples vs formula (§A9.1, p.19) [medium].** With
   `baseDelay·2^attempt`, attempt 1 is 2–3 s, not "~1–2 s"; the priority table
   skips priority 4 although the schema allows 1–5; and CRITICAL's 10 retries of up
   to 60 s each cannot meet a < 10 s margin-call objective. The table values are
   implemented; CRITICAL relies on failover, fallback channels and the reserved
   provider quota instead of waiting on retries.
4. **REGX-005 urgency (§A2.6 vs §B2.5) [medium].** REGX-005 is LOW / "< 24 hours" in
   the taxonomy but must reach every user within 4 hours in Challenge 5. The
   taxonomy value is implemented and the conflict documented.
5. **Frequency-cap arithmetic (§A6.2, p.14–15) [medium].** The per-channel daily caps
   sum to 16, above the 12/day global cap; the "> 8/day" digest threshold is tied to
   a rolling 7-day window; and the quiet-hours digest threshold (> 5) differs from
   Appendix B's "3+ capped". All caps are enforced independently (the global cap
   wins), the digest suggestion uses the 7-day average, and the morning digest uses > 5.
6. **API naming (Appendix A) [medium].** `usr_`/`ntf_`-prefixed ids contradict the
   UUID columns of §A8; `PUT` is used for a partial (one-category) update; and the
   202 response returns a single `notification_id` although one event fans out to
   one notification per channel. Both id forms are accepted, `PUT` is kept as
   specified, and the id returned is the event's request id.

## Further documentation

[docs/architecture.md](docs/architecture.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[docs/database-schema.md](docs/database-schema.md) ·
[docs/sequence-diagrams/](docs/sequence-diagrams/) · [DEPLOYMENT.md](DEPLOYMENT.md) ·
[SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) ·
[CHANGELOG.md](CHANGELOG.md) · [docs/TAXONOMY.md](docs/TAXONOMY.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/performance-benchmarks.md](docs/performance-benchmarks.md) ·
[docs/RUNBOOKS.md](docs/RUNBOOKS.md) · [docs/TRACEABILITY.md](docs/TRACEABILITY.md) ·
[docs/FINAL_GAP_ANALYSIS.md](docs/FINAL_GAP_ANALYSIS.md) · [docs/SUBMISSION.md](docs/SUBMISSION.md)
