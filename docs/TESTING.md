# Test and Coverage Report

Measured on 2026-10-11 (Apple M5, Node 26.8.2) against local PostgreSQL 16.15,
Redis 8.10, Kafka 4.3.1 and RabbitMQ 4.3.6. Command:

```bash
npm run test:coverage      # jest --runInBand --coverage (all three projects)
```

## 1. Results

| Project                           | Suites | Tests   | Result                   |
| --------------------------------- | ------ | ------- | ------------------------ |
| unit (`tests/unit`)               | 11     | 157     | all passed               |
| integration (`tests/integration`) | 8      | 130     | all passed               |
| e2e (`tests/e2e`)                 | 1      | 6       | all passed               |
| **Total**                         | **20** | **293** | **293 passed, 0 failed** |

Evidence: `reports/test-suites.txt`, `reports/coverage-summary.json`.

## 2. Coverage (all source files under `src/`)

| Metric     | Measured                | Threshold (enforced in `jest.config.js`) |
| ---------- | ----------------------- | ---------------------------------------- |
| Statements | **90.85 %** (3823/4208) | 80 %                                     |
| Lines      | **93.56 %** (3549/3793) | 80 %                                     |
| Functions  | **90.79 %** (789/869)   | 80 %                                     |
| Branches   | **77.70 %** (1899/2444) | 70 %                                     |

Branch coverage is below the 80 % aspiration; it is enforced at 70 %. The
lowest-covered areas are defensive branches in worker wiring
(`src/workers/workers.ts`), configuration error paths and some route
validation branches. Excluded from coverage: process entry points
(`src/server.ts`, `src/workers/main.ts`, `migrate.ts` CLI), which are exercised
by the smoke test and benchmark instead. The migration file reports 0 % because
the test database is migrated by Knex outside Jest's instrumentation.

## 3. What the suites cover

| Suite                      | Focus                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit/taxonomy              | 25 events, schemas, unknown/malformed payloads, decimals, https URLs, idempotency keys, guard rails, config-only extension                                                                                                       |
| unit/templates, unit/sms   | 625 renders (25 events × 5 locales × 5 channels), formatting, conditionals, locale fallback, missing variables, HTML escaping, header injection, template-injection rejection, prototype access, SMS segmentation                |
| unit/preferences           | 4-layer hierarchy, sources, timezone fallback, regulatory override scope                                                                                                                                                         |
| unit/quiet-hours           | windows across midnight, boundaries, DST (US spring/fall, UK), gap end times, digests                                                                                                                                            |
| unit/compliance            | consent rules (implied/explicit/revoked/WhatsApp), DND statuses, staleness, failures, caching                                                                                                                                    |
| unit/frequency-capper      | capper contract against the in-memory reference model                                                                                                                                                                            |
| unit/routing               | engine decisions incl. edge cases 1, 2, 10, 11, 16, budgets, fallbacks, determinism                                                                                                                                              |
| unit/backoff-circuit-state | retry formula & profiles, delay bands, circuit reducer, state machine                                                                                                                                                            |
| unit/security-config       | production fail-safe config, PII masking, structured logs, crypto, signatures, RBAC matrix                                                                                                                                       |
| integration/redis          | Lua capper contract on Redis, 50-way concurrency, TTLs, rate limiter, circuit Lua vs reference model, DND cache, mock store                                                                                                      |
| integration/brokers        | Kafka topics/ordering/headers/offsets, RabbitMQ priority, delay-band routing + dead-lettering, poison → DLQ, outbox relay incl. outage and SKIP LOCKED concurrency                                                               |
| integration/persistence    | encryption at rest, optimistic concurrency, consent ledger, partitions, dedupe keys, atomic transitions, keyset pagination                                                                                                       |
| integration/delivery       | event processor + dispatcher: failover, retries, permanent failures, fallback, DLQ retry/discard, circuit, rate limits, timeouts, crash recovery, preference changes, receipts                                                   |
| integration/races          | ack/receipt before SENT commit (regression tests for bugs found in e2e)                                                                                                                                                          |
| integration/providers      | Twilio, MSG91, FCM (real RSA-signed JWT), WhatsApp against HTTP stubs; Nodemailer against a real local SMTP server; fail-safe provider factory                                                                                   |
| integration/api            | health, metrics, OpenAPI completeness, headers, CORS, auth flows, RBAC, ingestion semantics, preferences, consent, compliance, templates, webhook signatures, anonymisation, retention, ops                                      |
| integration/scheduler      | quiet release, morning digest, cap re-check, crash recovery, DST scheduling, bypass audit, digest suggestion, sweeper                                                                                                            |
| integration/analytics      | exactly-once aggregation, rates, costs, engagement nulls, opt-out rate, Socket.IO auth                                                                                                                                           |
| e2e/pipeline               | full stack with all workers: HTTP → Kafka → RabbitMQ → providers → signed receipts → Socket.IO ack/read/click → analytics (< 30 s lag), mandatory override, failover, DLQ round trip, crash/outage recovery, duplicate ingestion |

**DND, frequency capping and quiet hours** (assignment minimum: 25 tests):
68 executed tests — quiet-hours unit 13, DND unit 10, capper contract 12 × 2
implementations, capper extras 3, scheduler 9, routing engine 9.

## 4. Mandatory edge cases

| #   | Edge case                                   | Tests                                                                                       |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | Mandatory margin call with disabled channel | unit/routing "edge 1"; integration/delivery "edge 1"; e2e "edge 1"                          |
| 2   | Promotional notification to DND recipient   | unit/routing "edge 2"; integration/delivery "edge 2"                                        |
| 3   | Preference change during processing         | integration/delivery "edge 3"                                                               |
| 4   | Provider unavailable during delivery        | integration/delivery "edge 4"; unit/routing (no healthy provider)                           |
| 5   | Failover to an available provider           | integration/delivery "edge 5"; e2e "edge 5"                                                 |
| 6   | Duplicate event ingestion                   | integration/api (202/200/409); integration/delivery "edge 6/8"; e2e "edge 6"; smoke step 15 |
| 7   | Duplicate webhook callbacks                 | integration/delivery "edge 7"; integration/api webhooks                                     |
| 8   | Worker crash and restart                    | integration/delivery "edge 8" ×2; integration/scheduler crash; e2e "edge 8"                 |
| 9   | Redis counter under concurrency             | integration/redis "edge 9"                                                                  |
| 10  | Deferred during quiet hours                 | unit/routing "edge 10"; integration/delivery "edge 10"; integration/scheduler               |
| 11  | Critical bypass with audit                  | unit/routing "edge 11"; integration/scheduler "edge 11"                                     |
| 12  | Invalid or expired authentication           | integration/api "authentication (edge 12)"                                                  |
| 13  | Unauthorised DLQ operations                 | integration/api "edge 13"; smoke step 13                                                    |
| 14  | Missing template variables                  | unit/templates (required → error, optional → reported)                                      |
| 15  | Unsupported locale fallback                 | unit/templates "falls back to English"                                                      |
| 16  | Expired/invalid push token                  | unit/routing "edge 16"; integration/delivery "edge 16"                                      |
| 17  | Permanent provider failure                  | integration/delivery "edge 17"; integration/providers classification                        |
| 18  | Exhausted retries                           | integration/delivery "edge 18"; e2e "edge 18/19"; smoke step 12                             |
| 19  | DLQ manual retry and resolution             | integration/delivery "edge 19" + discard; e2e; smoke step 13                                |
| 20  | Anonymisation and retention                 | integration/api "edge 20" ×2                                                                |
| 21  | Provider rate limiting                      | integration/delivery "edge 21"; integration/providers (429 + Retry-After)                   |
| 22  | Circuit breaker opening and recovery        | unit circuit tests; integration/delivery "edge 22"; integration/redis contract              |
| 23  | Invalid webhook signatures                  | integration/api "edge 23"; unit/security-config                                             |
| 24  | Scheduling across midnight                  | unit/quiet-hours; integration/scheduler "edge 24/25"                                        |
| 25  | Timezone and DST boundaries                 | unit/quiet-hours (US/UK DST, gap); integration/scheduler "edge 24/25"                       |

## 5. Static checks and audits

| Check                        | Command                | Result                                                                                                                                                                           |
| ---------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting                   | `npm run format:check` | pass                                                                                                                                                                             |
| ESLint (`strictTypeChecked`) | `npm run lint`         | pass (0 problems)                                                                                                                                                                |
| Type check                   | `npm run typecheck`    | pass                                                                                                                                                                             |
| Production build             | `npm run build`        | pass                                                                                                                                                                             |
| Production dependency audit  | `npm audit --omit=dev` | **0 vulnerabilities** (`reports/npm-audit-prod.txt`)                                                                                                                             |
| Full dependency audit        | `npm audit`            | 20 moderate, all one dev-only chain (`sprintf-js` via `argparse` → `js-yaml@3` → istanbul `load-nyc-config` inside Jest coverage); no upstream fix (`reports/npm-audit-all.txt`) |
| Secret scan                  | `npm run secrets:scan` | pass                                                                                                                                                                             |

## 6. Functional smoke test

`npm run smoke` against the compiled build (`node dist/src/server.js`,
`RUN_WORKERS=all`, mock providers with signed receipts): **15/15 steps
passed** — see `reports/smoke-test.json` (user creation, preferences,
asynchronous processing, decisions, templates, provider delivery, receipts,
history, simulated failure + retry, retry exhaustion → DLQ, authorised DLQ
retry and unauthorised discard, analytics, duplicate suppression).

## 7. Known test-environment caveats

- Integration/e2e tests must run in-band (shared `zetheta_test` database).
- Jest is invoked with `--forceExit` for integration/e2e because kafkajs and
  ioredis keep sockets in their reconnect timers after `disconnect()`; all
  suites pass before exit.
- Tests ran on Node 26; CI is configured for Node 20.19.6 but has not been
  executed.
