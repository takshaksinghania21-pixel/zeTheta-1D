# Zetheta BE-6B — Event-Driven Notification Engine

An event-driven backend that turns financial events (trades, margin calls, SIPs,
market alerts, regulatory notices) into compliant, personalised notifications
across **SMS, email, push, WhatsApp and in-app**, with durable asynchronous
processing, retries, a dead-letter queue, analytics and an operator API.

> Status: implemented and verified locally against real PostgreSQL, Redis,
> Kafka and RabbitMQ (see [Verification](#verification-summary)). Docker images
> and the GitHub Actions workflow are written but were **not executed** (no
> Docker on the authoring machine). Not production-ready — see
> [Known limitations](#known-limitations).

## Key features

- **25 financial event types** in five categories, defined in
  [`config/event-taxonomy.yaml`](config/event-taxonomy.yaml) and compiled to strict
  schemas; new event types need configuration + templates only.
- **Pipeline:** REST ingestion → idempotency → transactional outbox → Kafka →
  enrichment → preferences/consent/DND → quiet hours → frequency caps → templates
  → RabbitMQ priority queues → provider adapters → signed receipts → analytics.
- **Preference hierarchy** system → segment → user → regulatory override, with
  per-value provenance and auditable typed policy decisions.
- **Compliance:** consent ledger (separate WhatsApp opt-in), DND registry
  abstraction with cache/staleness rules, promotional vs transactional handling.
- **Frequency caps** (Redis Lua, atomic, idempotent): 12/day global, SMS 5, push
  8, email 3, 3/hour per category, 15-minute same-event cooldown, exemptions.
- **Quiet hours** per IANA timezone (DST-safe, ≥ 6 h), critical bypass with
  audit, durable deferral, morning digest when > 5 notifications were deferred.
- **Templates:** Handlebars sandbox, 5 locales (en, hi, mr, ta, te) × 26 templates
  × 5 channels, versioning, preview, SMS segment rules, safe HTML email.
- **Delivery:** Twilio + MSG91 (SMS), Nodemailer SMTP/Ethereal, FCM HTTP v1,
  WhatsApp Cloud API, Socket.IO in-app, and mock providers with failure injection.
  Failover, circuit breakers, provider rate limits, timeouts, error classification.
- **Retries/DLQ:** per-priority exponential backoff with jitter on RabbitMQ delay
  bands, durable state in PostgreSQL, DLQ with operator retry/resolve/discard.
- **Security:** JWT + refresh rotation, RBAC (ADMIN/OPERATOR/SERVICE/USER), Zod
  validation, rate limits, webhook signatures, AES-256-GCM contact encryption,
  PII-safe logs, audit log, retention and anonymisation.
- **Observability:** JSON logs with correlation ids, Prometheus `/metrics`,
  health/readiness, OpenAPI 3.0 + Swagger UI, Postman collection.

## Architecture summary

```
POST /events ─► PostgreSQL (event + outbox) ─► relay ─► Kafka financial-events.v1
                                                          │
                                       event-consumer ◄───┘  (routing, compliance,
                                          │                    caps, quiet hours,
                                          ▼                    templates)
                       PostgreSQL (notifications, history, decisions, outbox)
                                          │ relay
                                          ▼
                           RabbitMQ delivery.<channel> (priority)
                                          │
                              dispatcher ─┴─► providers ─► webhooks ─► DELIVERED/READ
                                          │
                     lifecycle events ─► Kafka ─► analytics aggregates
```

Details, sequence diagrams and the ER diagram: [ARCHITECTURE.md](ARCHITECTURE.md).

## Technology stack

| Concern            | Choice (pinned in `package.json`)                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Runtime / language | Node.js 20 LTS (Docker/CI), TypeScript 5.9 strict                                                                  |
| HTTP               | Express 5, Helmet, CORS, Zod 4, zod-to-openapi, swagger-ui-express                                                 |
| Data               | PostgreSQL 16 via Knex 3 (+ pg), Redis 7/8 via ioredis                                                             |
| Messaging          | Apache Kafka 4.3 (kafkajs), RabbitMQ 4.3 (amqplib)                                                                 |
| Templates          | Handlebars 4.7.10, Luxon (time zones)                                                                              |
| Providers          | Twilio REST, MSG91 Flow API, Nodemailer 10, FCM HTTP v1, WhatsApp Cloud API, Socket.IO 4 (+ Redis adapter/emitter) |
| Observability      | pino, prom-client                                                                                                  |
| Tests              | Jest 30, ts-jest, Supertest, socket.io-client, smtp-server                                                         |
| Load               | k6                                                                                                                 |
| Delivery           | Docker, Docker Compose, GitHub Actions                                                                             |

## Prerequisites

- Node.js ≥ 20.11 (verified on 26.8.2 locally; Docker/CI use 20.19.6 as required
  by the assignment — note Node 20 is past end-of-life since 2026-04-30).
- PostgreSQL 15+, Redis 7+, Kafka 3.6+/4.x (KRaft), RabbitMQ 3.12+ — either via
  Docker Compose or installed locally.
- Optional: k6 (load tests).

## Local installation

```bash
npm ci
cp .env.example .env        # then replace every CHANGE_ME value
```

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Start infrastructure — Docker (written, not verified locally)

```bash
docker compose up -d postgres redis kafka rabbitmq
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
npm run seed             # templates, principals, 6 synthetic users, DND fixtures
```

The seed writes generated credentials to `.local/seed-credentials.json`
(git-ignored, mode 0600): `admin`/`operator` (password grant),
`trading-platform` (client credentials, SERVICE role) and demo end user `asha`.

## Starting the API and workers

Single process (development):

```bash
RUN_WORKERS=all npm run dev:api
```

Separate processes (production-like):

```bash
npm run build
node dist/src/server.js
node dist/src/workers/main.js outbox-relay,event-consumer,scheduler,dlq-ingest
node dist/src/workers/main.js dispatcher
node dist/src/workers/main.js analytics
```

Workers serve `/health/live`, `/health/ready` and `/metrics` on `METRICS_PORT`.

## API documentation

- Swagger UI: <http://localhost:3000/api/docs>
- OpenAPI 3.0 JSON: <http://localhost:3000/api/v1/openapi.json> and
  [`docs/openapi.json`](docs/openapi.json) (`npm run openapi:generate`)
- Postman: [`docs/postman/zetheta-notification-engine.postman_collection.json`](docs/postman/zetheta-notification-engine.postman_collection.json) (`npm run postman:generate`)

The spec is generated from the same route definitions that register the Express
handlers; in non-production modes every response is validated against its
declared schema.

### Example requests

```bash
TOKEN=$(curl -s localhost:3000/api/v1/auth/token -H 'content-type: application/json' \
  -d '{"grantType":"client_credentials","clientId":"trading-platform","clientSecret":"<from .local/seed-credentials.json>"}' | jq -r .accessToken)
```

```bash
curl -s localhost:3000/api/v1/events -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "eventType": "RISK-001",
  "userId": "<user id>",
  "occurredAt": "2026-01-15T14:00:00+05:30",
  "payload": { "marginCallId": "MC-1", "marginRequired": "125000", "marginAvailable": "80000",
               "utilisationPercent": 156.25, "deadline": "2026-01-15T15:30:00+05:30" } }'
```

```bash
curl -s localhost:3000/api/v1/events/<eventId> -H "authorization: Bearer $TOKEN"
```

Other useful endpoints: `GET /api/v1/notifications?eventId=…`,
`GET /api/v1/notifications/{id}/history`, `PUT /api/v1/users/{id}/preferences/quiet-hours`,
`POST /api/v1/compliance/evaluate` (dry run), `GET /api/v1/dlq`,
`POST /api/v1/dlq/{id}/retry`, `GET /api/v1/analytics/summary`,
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

Real providers were verified against local HTTP/SMTP stubs only; no real
sandbox account was used.

## Running tests

```bash
npm run test:unit          # no infrastructure needed
npm run test:integration   # needs PostgreSQL (zetheta_test), Redis DB 6, Kafka, RabbitMQ
npm run test:e2e           # full pipeline with all workers in-process
npm run test:coverage      # everything + coverage thresholds
npm run smoke              # 15-step functional smoke test against a running stack
```

Integration tests use `zetheta_test`, Redis DB 6 and per-run Kafka/RabbitMQ name
prefixes; they never touch development data. Override with `TEST_DATABASE_URL`,
`TEST_REDIS_URL`, `TEST_KAFKA_BROKERS`, `TEST_RABBITMQ_URL`.

### Coverage

`npm run test:coverage` writes `coverage/` (lcov + summary). Thresholds:
statements/lines/functions 80 %, branches 70 %. Latest measured numbers:
[docs/TESTING.md](docs/TESTING.md).

## Verification summary

| Check                                                                   | Result                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Unit + integration + e2e tests                                          | all passing — counts and coverage in [docs/TESTING.md](docs/TESTING.md) |
| ESLint (strict type-checked), Prettier, `tsc --noEmit`, `npm run build` | pass                                                                    |
| Functional smoke test (15 steps, compiled build)                        | 15/15 — [`reports/smoke-test.json`](reports/smoke-test.json)            |
| 10 000-event benchmark                                                  | [docs/performance-benchmarks.md](docs/performance-benchmarks.md)        |
| `npm audit --omit=dev`                                                  | 0 vulnerabilities; dev-only findings in SECURITY.md                     |
| Docker build / compose / CI                                             | **not executed** (see DEPLOYMENT.md)                                    |

## Troubleshooting

See [docs/RUNBOOKS.md](docs/RUNBOOKS.md). Quick checks:

- `GET /health/ready` shows which dependency is down.
- Events stuck in `RECEIVED`: outbox relay not running or Kafka down
  (`GET /api/v1/ops/queues` → `outboxBacklog`).
- Notifications stuck in `QUEUED`: no dispatcher consuming
  (`rabbitmq.<queue>.consumers == 0`).
- `401 Invalid webhook signature`: wrong secret or clock skew > 300 s.
- Everything `QUIET` at night: quiet hours are working — check the user timezone.

## Security considerations

Summary in [SECURITY.md](SECURITY.md): RBAC, token rotation, encryption at rest,
PII masking, webhook verification, rate limiting, audit logs, and the
**compliance assumptions that require legal verification**.

## Known limitations

- Docker images, Compose stacks and GitHub Actions were not run (no Docker
  locally, no remote repository).
- Provider adapters verified against stubs, not real sandbox accounts.
- Delivery is at-least-once: a crash during a provider call can produce a
  duplicate message (documented in ARCHITECTURE.md §9).
- Benchmarks come from a single laptop; they are not production capacity claims.
- Template translations are machine-assisted and need native-speaker review.
- Email open/click tracking and FCM delivery receipts are not available
  (reported as `null`, never estimated).

## Further documentation

[ARCHITECTURE.md](ARCHITECTURE.md) · [DEPLOYMENT.md](DEPLOYMENT.md) ·
[SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md) ·
[CHANGELOG.md](CHANGELOG.md) · [docs/TAXONOMY.md](docs/TAXONOMY.md) ·
[docs/TESTING.md](docs/TESTING.md) · [docs/performance-benchmarks.md](docs/performance-benchmarks.md) ·
[docs/RUNBOOKS.md](docs/RUNBOOKS.md) · [docs/TRACEABILITY.md](docs/TRACEABILITY.md) ·
[docs/SUBMISSION.md](docs/SUBMISSION.md)
