# Submission and 15-Day Plan Mapping

## Honest timeline

The implementation was produced in two working sessions: the initial build on
2026-10-11 (commit `92f1bb9`) and a PDF audit + remediation on 2026-10-12
(commit `504b195` plus uncommitted work: the §E2 source move, routing priorities
3–4, feature store, capped-notification flow, Compose alignment, load runs). The
assignment's 15-day plan is mapped below to the deliverables that satisfy each
day; no artificial daily commits or backdated history were created. Paths follow
the PDF §E2 layout.

| Day | Plan                                                              | Delivered in                                                                                                                                                        |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Setup, strict TS, Compose, architecture, taxonomy, API contracts  | `tsconfig.json`, `eslint.config.mjs`, `docker-compose*.yml`, `ARCHITECTURE.md`, `docs/architecture.md`, `config/event-taxonomy.yaml`, `docs/api-specification.yaml` |
| 2   | Schema, migrations, models, indexing, seeds                       | `src/database/{migrations,models,seeds}`, `docs/database-schema.md` (Knex chosen over Prisma — ARCHITECTURE.md decisions)                                           |
| 3   | Ingestion, validation, Kafka producer/consumer, idempotency       | `src/events/{ingestion,processor}.ts`, `src/events/validators/*`, `src/infrastructure/kafka/kafka.ts`, `src/infrastructure/outbox/outbox.ts`                        |
| 4   | RabbitMQ routing, priority queues, workers, retry/DLQ foundations | `src/infrastructure/rabbitmq/rabbitmq.ts`, `src/workers/*`, `src/delivery/retry/*`                                                                                  |
| 5   | Templates, personalisation, localisation, versioning              | `src/templates/{engine,definitions,locales}`, `templates/*.yaml`                                                                                                    |
| 6   | Preferences, DND, consent, frequency caps, quiet hours            | `src/preferences/*`, `src/compliance/{dnd,frequency-cap,quiet-hours}`, `src/compliance/consent.ts`                                                                  |
| 7   | Five providers, abstraction, circuit breakers, integration tests  | `src/delivery/providers/*`, `src/delivery/circuit-breaker/*`, `tests/integration/providers.test.ts`                                                                 |
| 8   | Lifecycle, receipts, history, webhooks                            | `src/notifications/state-machine/*`, `src/notifications/engine/*`, `src/delivery/webhooks/*`                                                                        |
| 9   | Retry recovery, failover, DLQ management, ops tooling             | `src/delivery/dispatcher.ts`, `src/delivery/retry/retry-scheduler.ts` (Redis ZSET), `src/delivery/dlq/*`, `src/api/routes/ops.ts`                                   |
| 10  | Analytics pipeline, metrics, reporting APIs                       | `src/analytics/{service,feature-store}.ts`, `src/utils/metrics.ts`, `config/prometheus-alerts.yml`                                                                  |
| 11  | Auth, RBAC, validation, rate limiting, PII, retention, load tests | `src/api/middleware/*`, `src/utils/{rate-limiter,crypto,pii}.ts`, scheduler retention, `tests/load/scenarios.js`                                                    |
| 12  | Logging, correlation ids, health, shutdown, alerts                | `src/utils/{logger,context}.ts`, `src/app.ts`, `src/server.ts`, DEPLOYMENT.md §8                                                                                    |
| 13  | OpenAPI, Swagger, Postman, tests, coverage                        | `docs/openapi.json`, `/api-docs`, `docs/postman/*`, `tests/*`, docs/TESTING.md                                                                                      |
| 14  | Docker hardening, CI, security scanning, performance              | `Dockerfile`, `.github/workflows/ci.yml`, `scripts/scan-secrets.ts`, docs/performance-benchmarks.md                                                                 |
| 15  | Documentation, verification, cleanup, transfer readiness          | README, SECURITY, DEPLOYMENT, CONTRIBUTING, CHANGELOG, docs/\*, this file                                                                                           |

## Deployment validation (Docker) — done 2026-10-12

The Compose stack was built and run on Docker Desktop 29.8.2 / Compose v5.5.1
(macOS arm64): all services healthy, PostgreSQL TLS mandatory and verified, smoke
test 15/15 against the containers, graceful shutdown, stop/start and down/up with
data kept, and the full test suite on Node 20.19.6. Evidence:
`reports/docker-validation.txt`, `reports/smoke-test-docker.json`,
`reports/docker-functional.json`, `reports/test-suites-node20.txt`; details in
docs/IMPLEMENTATION_STATUS.md (Phase 9). To reproduce:

```bash
scripts/dev-certs.sh
```

```bash
docker compose --env-file .env --env-file .local/compose.env up -d --build --wait
```

```bash
BASE_URL=http://localhost:3000 SEED_CREDENTIALS_FILE=.local/compose-seed-credentials.json npm run smoke
```

`.local/compose.env` holds `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`,
`SEED=true`, the `SEED_*` passwords and optional `*_HOST_PORT` overrides;
`.local/compose-seed-credentials.json` holds the same seed credentials in the smoke
test's format (both git-ignored). Stop with `docker compose stop` (keeps data).

## Remaining requirements (pre-commit audit, 2026-10-14)

Classified against the PDF wording. Status per requirement: docs/TRACEABILITY.md.

| Requirement                                             | Class                   | Why                                                                                                                       | What is left                                                                                    |
| ------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Consolidated PDF/xlsx (DEL-13, p.53)                    | **Mandatory**           | "All daily deliverables … submitted on Day 15 as a consolidated final submission"                                         | Produce 1–2 PDFs and/or one .xlsx named `ProjectCode_YourName_DeliverableName`, sections by day |
| Per-day commits + transfer (DEL-12, p.43–53)            | **Mandatory**           | Each day lists a "Git commit: '…'" deliverable; Day 15 requires transfer to @ZethetaIntern                                | See "Commit history" below; transfer is an owner action                                         |
| `.zetheta-project.json` personal fields (DEL-06, p.57)  | **Mandatory**           | §E3 "MANDATORY"                                                                                                           | Fill `intern_id`, `intern_name`, `intern_email` (`github_repo_url` is set)                      |
| Remote CI run (DEL-03, p.52)                            | **Mandatory**           | Day 14 deliverable: GitHub Actions pipeline                                                                               | Push to a private repo; every step was reproduced locally                                       |
| 450K / 30-min market-crash test (PERF-02, p.50)         | **Mandatory** (Day 11)  | "Test the market crash scenario from Part B: 450K notifications in 30 minutes"                                            | Not run at full size (a 120 s mix at 268/s was); can be run locally with `DURATION=30m`         |
| Provider sandboxes (RT-01/RT-11, p.48)                  | Conditional             | Implementations must target test modes (done); the Day 7 test deliverable is "integration tests with mock servers" (done) | Real sandbox runs need your MSG91/Twilio, Firebase, Meta and Ethereal accounts                  |
| Snyk (SEC-13)                                           | Conditional             | Needs a `SNYK_TOKEN`; npm audit + gitleaks run                                                                            | Add the secret after transfer if wanted                                                         |
| Native review of hi/mr/ta/te templates (TPL-03)         | Conditional (quality)   | Translations exist and render; accuracy needs a native reader                                                             | Human review                                                                                    |
| §B3.4 bonus challenges (SIM-07)                         | Optional                | "These are optional challenges"                                                                                           | —                                                                                               |
| Other PARTIAL items (design depth, single-machine load) | Implemented with limits | Documented in FINAL_GAP_ANALYSIS §6 and §13                                                                               | —                                                                                               |

## Commit history (DEL-12) — honest options

The PDF asks for a commit per day with prescribed messages. The work happened on
2026-10-11, 2026-10-12 and 2026-10-14, so a 15-day history cannot be shown without
fabricating dates — **do not backdate** (`--date`, `GIT_COMMITTER_DATE`). Honest
options: commit the current work today, either as one commit or split into a few
commits that use the PDF's message for the area each one covers, and finish with
the prescribed `chore: final documentation and cleanup for repository transfer`;
the CHANGELOG and the "Honest timeline" above explain the mapping.

## Repository transfer checklist (Day 15) — manual steps for the owner

The repository currently exists **only locally** (no remote was created and
nothing was pushed). Transfer must be done by the repository owner; it was
intentionally not automated.

- [ ] Fill in `.zetheta-project.json`: `intern_id`, `intern_name`, `intern_email`
      are still `[PLACEHOLDER]` values (`github_repo_url` is set to the pushed repository).
- [ ] Commit the remaining working-tree changes (review `git status` first).

- [ ] Create a **private** GitHub repository under your account (e.g. `gh repo create <name> --private --source . --push`).
- [ ] Confirm `.env`, `.local/` and `coverage/` are not tracked (`git ls-files | grep -E '^\.env$|^\.local/'` returns nothing).
- [ ] Let the CI workflow run once (it has not been executed; its steps were reproduced locally with Docker, including the Node 20 test run and the image gates) and fix anything runner-specific.
- [ ] Verify the destination account handle **@ZethetaIntern** exactly (spelling/case) and that it can receive transfers (organisation vs user account, name collisions).
- [ ] Transfer via _Settings → General → Danger Zone → Transfer ownership_; type the repository name to confirm.
- [ ] After transfer: confirm the new URL, that you retain/drop access as intended, that Actions secrets (e.g. `SNYK_TOKEN`) are re-created by the new owner, and that branch protection is configured.
- [ ] Submit the repository URL plus links to README.md, docs/TRACEABILITY.md, docs/TESTING.md and docs/performance-benchmarks.md.

## Required submission files

README.md · ARCHITECTURE.md · CHANGELOG.md · DEPLOYMENT.md · SECURITY.md ·
CONTRIBUTING.md · .env.example · docker-compose.yml · docker-compose.test.yml ·
Dockerfile · docs/openapi.json · docs/postman/… · config/event-taxonomy.yaml ·
src/database/migrations/… · src/database/seeds/seed.ts · tests/ ·
tests/load/ · .github/workflows/ci.yml · docs/TESTING.md · docs/performance-benchmarks.md ·
docs/RUNBOOKS.md · docs/TRACEABILITY.md · docs/FINAL_GAP_ANALYSIS.md ·
docs/architecture.md · docs/database-schema.md · docs/sequence-diagrams/ ·
docs/api-specification.yaml · reports/
