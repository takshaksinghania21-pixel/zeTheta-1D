# Submission and 15-Day Plan Mapping

## Honest timeline

The whole implementation was produced in one working session on 2026-10-11.
The assignment's 15-day plan is mapped below to the deliverables that satisfy
each day; no artificial daily commits or backdated history were created.

| Day | Plan                                                              | Delivered in                                                                                                              |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Setup, strict TS, Compose, architecture, taxonomy, API contracts  | `tsconfig.json`, `eslint.config.mjs`, `docker-compose*.yml`, `ARCHITECTURE.md`, `config/event-taxonomy.yaml`, `src/api/*` |
| 2   | Schema, migrations, models, indexing, seeds                       | `src/infrastructure/database/*`, `scripts/seed.ts` (Knex chosen over Prisma — ARCHITECTURE.md §11)                        |
| 3   | Ingestion, validation, Kafka producer/consumer, idempotency       | `src/modules/events/*`, `src/infrastructure/kafka/kafka.ts`, `src/infrastructure/outbox/outbox.ts`                        |
| 4   | RabbitMQ routing, priority queues, workers, retry/DLQ foundations | `src/infrastructure/rabbitmq/rabbitmq.ts`, `src/workers/*`, `src/modules/retries/backoff.ts`                              |
| 5   | Templates, personalisation, localisation, versioning              | `src/modules/templates/*`, `templates/*.yaml`                                                                             |
| 6   | Preferences, DND, consent, frequency caps, quiet hours            | `src/modules/preferences`, `compliance`, `frequency`, `scheduling/quiet-hours.ts`                                         |
| 7   | Five providers, abstraction, circuit breakers, integration tests  | `src/infrastructure/providers/*`, `src/modules/delivery/*`, `tests/integration/providers.test.ts`                         |
| 8   | Lifecycle, receipts, history, webhooks                            | `src/domain/state-machine.ts`, `src/modules/notifications/*`, `src/modules/webhooks/*`                                    |
| 9   | Retry recovery, failover, DLQ management, ops tooling             | `src/modules/delivery/dispatcher.ts`, `src/modules/dlq/*`, `src/api/routes/ops.ts`                                        |
| 10  | Analytics pipeline, metrics, reporting APIs                       | `src/modules/analytics/*`, `src/common/metrics.ts`                                                                        |
| 11  | Auth, RBAC, validation, rate limiting, PII, retention             | `src/modules/auth/*`, `src/common/rate-limiter.ts`, `src/common/crypto.ts`, `src/common/pii.ts`, scheduler retention      |
| 12  | Logging, correlation ids, health, shutdown, alerts                | `src/common/logger.ts`, `src/common/context.ts`, `src/app.ts`, `src/server.ts`, DEPLOYMENT.md §8                          |
| 13  | OpenAPI, Swagger, Postman, tests, coverage                        | `docs/openapi.json`, `/api/docs`, `docs/postman/*`, `tests/*`, docs/TESTING.md                                            |
| 14  | Docker hardening, CI, security scanning, load testing             | `Dockerfile`, `.github/workflows/ci.yml`, `scripts/scan-secrets.ts`, `tests/load/*`, docs/performance-benchmarks.md       |
| 15  | Documentation, verification, cleanup, transfer readiness          | README, SECURITY, DEPLOYMENT, CONTRIBUTING, CHANGELOG, docs/\*, this file                                                 |

## Repository transfer checklist (Day 15) — manual steps for the owner

The repository currently exists **only locally** (`git init` was performed;
no remote was created and nothing was pushed). Transfer must be done by the
repository owner; it was intentionally not automated.

- [ ] Create a **private** GitHub repository under your account (e.g. `gh repo create <name> --private --source . --push`).
- [ ] Confirm `.env`, `.local/` and `coverage/` are not tracked (`git ls-files | grep -E '^\.env$|^\.local/'` returns nothing).
- [ ] Let the CI workflow run once; fix anything environment-specific (it has not been executed yet).
- [ ] Verify the destination account handle **@ZethetaIntern** exactly (spelling/case) and that it can receive transfers (organisation vs user account, name collisions).
- [ ] Transfer via _Settings → General → Danger Zone → Transfer ownership_; type the repository name to confirm.
- [ ] After transfer: confirm the new URL, that you retain/drop access as intended, that Actions secrets (e.g. `SNYK_TOKEN`) are re-created by the new owner, and that branch protection is configured.
- [ ] Submit the repository URL plus links to README.md, docs/TRACEABILITY.md, docs/TESTING.md and docs/performance-benchmarks.md.

## Required submission files

README.md · ARCHITECTURE.md · CHANGELOG.md · DEPLOYMENT.md · SECURITY.md ·
CONTRIBUTING.md · .env.example · docker-compose.yml · docker-compose.test.yml ·
Dockerfile · docs/openapi.json · docs/postman/… · config/event-taxonomy.yaml ·
src/infrastructure/database/migrations/… · scripts/seed.ts · tests/ ·
tests/load/ · .github/workflows/ci.yml · docs/TESTING.md · docs/performance-benchmarks.md ·
docs/RUNBOOKS.md · docs/TRACEABILITY.md · reports/
