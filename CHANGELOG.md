# Changelog

All notable changes are documented here. Dates are real; this project was
implemented in a single working session on 2026-10-11 (see
docs/SUBMISSION.md for the mapping to the assignment's 15-day plan — work was
not spread over 15 days and no backdated history was created).

## [1.0.0] — 2026-10-11

### Added

- Event taxonomy (25 event types, 5 categories) with compiled strict schemas,
  load-time guard rails, idempotency/cooldown key fields.
- PostgreSQL schema (Knex migration): monthly-partitioned notifications,
  history, attempts, decisions, consent ledger, DND registry, templates and
  versions, DLQ, outbox, scheduled jobs, analytics aggregates, principals,
  refresh tokens, audit log; extension-agnostic migration source.
- Ingestion API (single + batch) with payload-hash idempotency and outbox
  publication to Kafka; Kafka event consumer; lifecycle events to Kafka.
- Routing engine: preference hierarchy, regulatory overrides, consent, DND,
  budgets, provider health, digests, quiet hours, frequency caps, fallbacks.
- Redis Lua frequency capper (atomic, idempotent, dry-run), sliding-window rate
  limiter, shared circuit breaker, DND cache.
- Handlebars template engine with sandboxing, 5 locales × 26 templates × 5
  channels, versioning API and previews.
- RabbitMQ topology: priority delivery queues, delay-band retry queues, DLX.
- Dispatcher with failover, circuit breaking, provider rate limits, timeouts,
  crash recovery, preference re-check, retries, DLQ and fallback channels.
- Providers: Twilio, MSG91, SMTP (Nodemailer), FCM HTTP v1, WhatsApp Cloud API,
  Socket.IO in-app, mock providers with failure injection and signed receipts.
- Webhooks (HMAC, Twilio, Meta, MSG91) with de-duplication and parking of
  receipts that arrive before the SENT commit.
- Scheduler: quiet-hours release with morning digest, preference digests,
  sweeper, partition maintenance, 90-day retention.
- Analytics pipeline and API; Prometheus metrics; health/readiness; graceful
  shutdown.
- Auth (JWT, refresh rotation with reuse detection, scrypt), RBAC, audit log,
  anonymisation.
- OpenAPI 3.0 generation, Swagger UI, Postman collection.
- Tests (unit, integration, e2e), smoke test, k6 load tests and benchmark.
- Dockerfile, Compose files, GitHub Actions workflow, documentation.

### Fixed during verification

- RabbitMQ headers-exchange binding used an `x-` prefixed key (ignored by
  RabbitMQ), fanning retries out to every delay band.
- Manual DLQ retry reset `retry_count`, reviving stale in-flight retry messages;
  replaced with `retry_budget_start`.
- In-app acks / receipts arriving before the SENT commit were lost.
- Morning digest counted multi-channel deferrals of one event twice.
- Phone-number masking regex corrupted UUIDs in logs.
- State-history ordering within the same millisecond was nondeterministic.
- Migrations recorded with file extensions broke compiled deployments.
- Vulnerable dependency versions (handlebars, nodemailer, yaml, jest,
  typescript-eslint, smtp-server) upgraded; k6 summary no longer stores tokens.
