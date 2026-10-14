# Changelog

All notable changes are documented here. Dates are real: the project was built on
2026-10-11 and audited against the assignment PDF and remediated on 2026-10-12
(see docs/SUBMISSION.md for the mapping to the assignment's 15-day plan — work was
not spread over 15 days and no backdated history was created).

**AI usage (PDF §E4).** An AI coding assistant was used throughout. It
significantly accelerated the requirement-by-requirement audit against the PDF,
test scaffolding, Docker/Compose and CI configuration, load-test scripts and
documentation drafting. Every change was reviewed and checked against the PDF and
the test suite; anything not verified is labelled as such.

## [1.1.0] — 2026-10-12 — PDF audit and remediation

Full audit trail: docs/TRACEABILITY.md, docs/FINAL_GAP_ANALYSIS.md,
docs/IMPLEMENTATION_STATUS.md.

### Changed

- Source tree moved to the PDF §E2 layout (`src/events`, `src/notifications`,
  `src/delivery`, `src/templates`, `src/compliance`, `src/database`, `src/utils`…).
- Taxonomy realigned with PDF §A2 / Appendix A (priorities, channels, latency
  objectives, mandated channels); binary TRANSACTIONAL/PROMOTIONAL classes.
- Kafka topics renamed to `notification-events`, `notification-critical`,
  `notification-lifecycle`, `notification-dlq`; CRITICAL events have their own
  topic, consumer group and Compose worker; manual offset commits.
- Retries scheduled in a Redis ZSET (PDF Day 9) instead of RabbitMQ delay-band
  queues; PostgreSQL `next_attempt_at` stays the durable record.
- Metric names and the seven alerts follow PDF §A11 (`config/prometheus-alerts.yml`).
- API accepts and returns the Appendix A snake_case contracts additively.
- Compose follows Appendix C: Confluent Kafka 7.5 + ZooKeeper, `app` service,
  PostgreSQL TLS, Redis dangerous commands disabled; Node 20 image < 200 MB.
- Jest config in TypeScript; 80 % coverage enforced on all four metrics
  (branches was 70 %).

### Added

- Routing priorities 3–4 (§A3.2): engagement-based channel choice, cost
  optimisation, per-user daily/monthly budgets.
- Redis feature store: real-time per-minute counters
  (`GET /analytics/realtime`) and per-user channel engagement.
- Capped notifications follow Appendix B: released in the next cap window, or
  folded into a digest when three or more are waiting.
- DND re-check at dispatch with stored evidence; DND violation gauge.
- 20 % of each provider's quota reserved for CRITICAL traffic.
- Storm de-duplication window for market alerts (§B2.4).
- DLQ classification (transient / permanent / configuration).
- k6 rate scenarios (normal, 10×, 20×, market crash, critical isolation),
  EXPLAIN ANALYZE report, 1 000-user seed and dataset generator, sequence
  diagrams, database schema and architecture docs.

### Fixed

- CRITICAL push p99 was 121 s behind bulk HIGH traffic (shared provider quota);
  now 139 ms with the reserved quota.
- Under 20× overload, 55 notifications were dead-lettered for our own local
  rate limit; throttled-only attempts no longer spend the retry budget.
- A poison DLQ message with a non-UUID id was requeued forever.
- Quiet-hours release consumed one cap slot per channel instead of per event.
- Digests skipped the dispatch-time DND/consent check and were classed SERVICE.
- Capped notifications were dropped instead of rescheduled.
- Storm de-duplication collisions returned 409 instead of a duplicate response.
- k6 summaries exported the service token (`setup_data`); now stripped.

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
