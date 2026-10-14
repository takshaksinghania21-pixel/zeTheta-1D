# Implementation Status — Assignment Compliance Audit & Remediation

Running log of the audit/remediation of the BE-6B notification engine against
the assignment PDF (`493560D_Event_Driven_Notification_Engine`, 74 pages). Each
phase records what was done, findings, files changed, commands, results,
remaining work and blockers so a later session can resume without repeating
work. Companion documents: [TRACEABILITY.md](TRACEABILITY.md) (per-requirement
matrix) and [FINAL_GAP_ANALYSIS.md](FINAL_GAP_ANALYSIS.md) (findings and plan).

Audit started 2026-10-12 on branch `main` at commit `92f1bb9`, clean tree.

---

## Phase 1 — Read the PDF and extract requirements ✅

- The full PDF (74 pages) was extracted to text with macOS PDFKit (no PDF
  tooling was installed; nothing was added to the system) and read end to end,
  including the appendices (A: API contracts, B: sequence diagrams,
  C: Docker Compose reference, D: glossary).
- Requirements were extracted per section (A1–A13, B1–B4, C1–C7, D Day 1–15,
  E1–E5, F, Appendices A–C) into [TRACEABILITY.md](TRACEABILITY.md).
- Ambiguities and suspected "deliberate errors" (PDF §A13 says the document
  contains five) are recorded, not silently resolved — see
  FINAL_GAP_ANALYSIS.md §2.3 and the README "Document Error Log".

## Phase 2 — Graphify architecture map ✅

- Skill: `~/.claude/skills/graphify/SKILL.md`, package `graphifyy` 0.9.85
  (already installed via `uv`; nothing installed).
- Steps run as specified by the skill: detect → AST extraction (code) +
  semantic extraction (2 general-purpose subagents for 27 doc/config files) →
  merge → build/cluster → health check → community labelling → HTML export →
  manifest/cost.
- Corpus: 161 files (134 code, 27 docs), ~121 k words. Graph: **1 473 nodes,
  3 996 edges, 83 communities**. Semantic extraction cost 226 960 subagent
  tokens (input/output split not reported by the Agent tool; recorded as input).
- Health check warning (surfaced, not hidden): 11 dangling-endpoint edges,
  9 self-loops, 44 collapsed duplicate edges — almost all repeated imports of
  the same module; the graph is usable.
- Outputs: `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`,
  `graphify-out/graph.html` (not committed; `graphify-out` added to
  `.prettierignore` because its JSON cache otherwise fails `format:check`).
- Findings derived from the graph and **verified in source** are in
  FINAL_GAP_ANALYSIS.md §3.

## Phase 3 — Verification baseline ✅

Environment: macOS, Node 26.8.2 (the PDF requires Node 20 LTS; the Dockerfile
uses 20.19.6), PostgreSQL 16 and Redis (Homebrew services), Kafka 4.3.1 and
RabbitMQ 4.3.6 started project-locally with `scripts/local-infra.sh start`
(data in `./.local`). **Docker is not installed** (`docker: command not found`);
gitleaks and Snyk are not installed. k6 is installed.

Data-safety confirmation before running tests: dev uses database `zetheta` and
Redis DB 5; tests use database `zetheta_test` (truncate guarded by a name check),
Redis DB 6 (18 expiring test keys before the run; `scheduler.test.ts` flushes
DB 6 only), and random per-run Kafka/RabbitMQ prefixes.

| Command                                       | Result                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run typecheck`                           | pass                                                                                    |
| `npm run lint`                                | pass (0 warnings)                                                                       |
| `npm run format:check`                        | pass for project files (16 warnings were graphify-out cache files → ignored)            |
| `npx jest --runInBand --coverage --forceExit` | **20/20 suites, 293/293 tests pass**                                                    |
| Coverage (baseline)                           | statements 90.85 %, **branches 77.70 %**, functions 90.79 %, lines 93.56 %              |
| Configured threshold                          | branches **70 %** (PDF Day 13 requires 80 % "code coverage across the entire codebase") |

## Phase 4 — Traceability and gap analysis ✅

Written: [TRACEABILITY.md](TRACEABILITY.md) (rebuilt from the PDF; previous
matrix tracked a paraphrased requirement list) and
[FINAL_GAP_ANALYSIS.md](FINAL_GAP_ANALYSIS.md).

## Phase 5 — P0/P1 remediation ✅ (owner decisions recorded)

Owner decisions (asked during the session): keep the source tree layout and add
the §E2 documentation paths only; **replace RabbitMQ delay-band retries with a
Redis sorted-set retry scheduler**; make the API Appendix-A compatible
**additively** (PDF-shaped requests get PDF-shaped responses; native camelCase
API unchanged except where a field had to change, see below).

| Fix                                                                                                                                                                                                                                                                                                                                                                                       | Files                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| D1 DND re-checked as the last step before SMS dispatch; dispatch-time decision persisted (audit proof); QUEUED/RETRYING → DND                                                                                                                                                                                                                                                             | `src/modules/delivery/dispatcher.ts`, `src/domain/state-machine.ts`, `src/container.ts`       |
| D2 DND data stale after 24 h (max 24; was 168) — local `.env` value changed from 168 to 24                                                                                                                                                                                                                                                                                                | `src/config/env.ts`, `.env.example`, `.env`                                                   |
| D3/D4 Taxonomy realigned with PDF §A2 + Appendix A (priorities, channels, mandatory channels, latency, CRITICAL bypass); binary TRANSACTIONAL/PROMOTIONAL classification enforced by the loader; copies at `docs/event-taxonomy.yaml`, `src/events/taxonomy.yaml`                                                                                                                         | `config/event-taxonomy.yaml`, `src/modules/taxonomy/taxonomy.ts`                              |
| RISK-001 payload = Appendix A sample (array field type, `future`/`positive` rules); RISK-001 templates in 5 locales re-pointed to the new fields (reusing existing translated sentences)                                                                                                                                                                                                  | taxonomy, `templates/*.yaml`, `src/modules/taxonomy/fixtures.ts`                              |
| D6 Kafka topics `notification-events` / `notification-critical` (dedicated consumer group `critical-consumer`) / `notification-dlq` (now produced to); manual offset commits; per-partition lag                                                                                                                                                                                           | `src/infrastructure/kafka/kafka.ts`, `src/workers/*`, `src/server.ts`, ingestion, DLQ service |
| RET-03 Redis ZSET retry scheduler (Lua atomic pop, per-tick cap as retry-storm guard, PostgreSQL `next_attempt_at` + sweeper as durability backstop); RabbitMQ retry exchange/band queues and outbox `expirationMs` removed                                                                                                                                                               | `src/modules/retries/retry-scheduler.ts`, dispatcher, rabbitmq, outbox, workers               |
| D7 Metrics renamed to §A11.1 names/labels; `notification_dnd_blocks_total`, `notification_retry_queue_depth` added; delivery latency observed at DELIVERED                                                                                                                                                                                                                                | `src/common/metrics.ts`, lifecycle, dispatcher, processor                                     |
| D9 Migration `20261012000001_pdf_alignment`: A8.2 indexes, PDF-named views, DLQ classification column, digest-suggestion count column                                                                                                                                                                                                                                                     | `src/infrastructure/database/migrations/`                                                     |
| D10 Circuit breaker: 5 failures in a 60 s window (successes no longer reset the count), 60 s open                                                                                                                                                                                                                                                                                         | circuit-breaker + Redis Lua mirror, policy                                                    |
| D11 SMS ≤ 160 chars (GSM-7 / UCS-2 units) with ellipsis, trailing link preserved                                                                                                                                                                                                                                                                                                          | `src/modules/templates/sms.ts`, engine, policy                                                |
| D12 Price-alert storm dedup: `idempotencyWindowSeconds` (MKTX-001: symbol + 60 s window); per-event cooldown override                                                                                                                                                                                                                                                                     | taxonomy, ingestion, capper, routing                                                          |
| D13 `/api-docs` Swagger UI; `/health` aggregate (deps + providers)                                                                                                                                                                                                                                                                                                                        | `src/app.ts`                                                                                  |
| D5 Appendix A: PDF envelope on `POST /events` (+422 `VALIDATION_FAILED`), `GET/PUT /users/:id/preferences` PDF view/update with warnings + `cache_invalidated`, `/analytics/delivery-rates`, `/channel-performance`, `/opt-out-trends`, `/preference-changes`, notification detail with `state_history`/`compliance` (detail `priority` is now the §A8 integer; label in `priorityLabel`) | `src/api/pdf-contract.ts`, `src/api/http.ts`, routes, analytics service                       |
| PRF-04 Redis preference cache (versioned write-through, 60 s TTL; dispatch re-check reads PostgreSQL)                                                                                                                                                                                                                                                                                     | `src/modules/users/repository.ts`, context                                                    |
| CMP-11 Digest suggestion when > 8 notifications/day over 7 days                                                                                                                                                                                                                                                                                                                           | processor, capper, policy                                                                     |
| D23 (gap analysis numbering) Quiet-hours release checked caps per channel notification (one event consumed several category slots) — fixed to per event                                                                                                                                                                                                                                   | `src/modules/scheduling/scheduler.ts`                                                         |
| DLQ classification, reason/classification filters; saga escalation `ESCALATE_MANUAL_CALL`                                                                                                                                                                                                                                                                                                 | dlq repo, ops routes, processor                                                               |
| D15 Log keys `timestamp`/`correlation_id`/`service_name`; masks `+91XXXX1234`, `s***@domain.com`; dead root-logger code removed                                                                                                                                                                                                                                                           | logger, pii, server, workers                                                                  |
| HOURLY digest frequency (PDF `digest_mode: hourly`)                                                                                                                                                                                                                                                                                                                                       | types, quiet-hours                                                                            |

Commands: `npm run typecheck` ✅, `npx jest --runInBand --forceExit` → **20/20
suites, 344/344 tests** (2026-10-12).

## Phase 6 — Resume, §E2 repository layout ✅ (2026-10-12)

Resumed from commit `504b195` (Phases 1–5) with a clean tree. Re-read PDF §E2
(p.55): _"Your repository MUST follow this exact structure. The automated
assessment tool expects these paths"_ — mandatory, so (per the owner's resume
instruction) the source tree was migrated instead of only documenting a mapping.

- 71 files moved by a scripted migration that rewrote every relative import
  (`src/modules/*`, `src/common`, `src/domain`, `src/infrastructure/{providers,database}`
  → `src/{events,notifications,delivery,templates,preferences,compliance,analytics,api,database,utils}`;
  the full old→new map is in docs/architecture.md). Kafka/RabbitMQ/Redis/outbox
  adapters stay in `src/infrastructure/`, workers in `src/workers/` (extra
  directories; every §E2 path exists).
- New, non-empty §E2 directories: `src/events/validators/` (payload field
  compiler and envelope schemas split out of the taxonomy model and
  ingestion), `src/templates/locales/` (locale tags), `src/database/seeds/`
  (seed + synthetic data, moved from `scripts/`).
- `jest.config.js` → `jest.config.ts`; `ts-node@10.9.2` added (dev, exact) because
  Jest needs it to load a TypeScript config on Node 20 (the PDF runtime). Locally
  (Node 26) the config loads natively; **Node 20 loading is unverified** (no Node 20
  installed) until CI runs.
- Updated: package.json scripts, tsconfig(.build), ESLint config, CI migrate
  step, docker-compose migrate/seed command.
- Fixed lint findings surfaced by the move (untyped rows and non-null
  assertions in the seed/synthetic helpers).

Verification: `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run format:check` ✅ ·
`npx jest --runInBand --forceExit` → 23/23 suites, 369/369 tests ✅ ·
`npm run build` ✅ · `node dist/src/database/migrate.js latest` ✅ ·
`npm run seed` / `npm run seed:prod` ✅ (idempotent).

Remaining (in order): Graphify refresh · per-user cost budgets + engagement
scoring (A3.2 P3/P4) · Redis real-time counters (Day 10) · APNS failover (Day 8) ·
correlation id to providers · Compose (Appendix C services, PostgreSQL SSL, Redis
command renaming) · documentation set (architecture.md, database-schema.md,
sequence diagrams, Document Error Log, README/ARCHITECTURE/DEPLOYMENT/RUNBOOKS/
TESTING/CHANGELOG/SECURITY/TAXONOMY) · load re-runs + EXPLAIN on volume ·
final traceability/gap update.

## Phase 7 — Remaining remediation ✅ (2026-10-12)

| Item                                         | Change                                                                                                                                                                                                                | Evidence                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| RT-04 routing priority 3                     | `analytics/feature-store.ts` (per-user, per-channel engagement in Redis, 90 d); `routing-engine.ts` `optimise()` drops ignored channels / adds a better-engaged one; skipped for mandatory/CRITICAL                   | unit/routing, int/redis, e2e                                                           |
| RT-05 routing priority 4                     | `routing/budget.ts` per-user day/month budgets (`USER_BUDGET_EXHAUSTED`); `COST_OPTIMISED` drops SMS for MEDIUM/LOW when a cheaper intrusive channel exists                                                           | unit/routing, int/delivery                                                             |
| AN-04 Redis real-time counters               | `rt:<minute>` hashes, `GET /analytics/realtime?minutes=`                                                                                                                                                              | int/redis, e2e                                                                         |
| OBS-03 correlation id                        | FCM `data.correlationId`, WhatsApp `biz_opaque_callback_data` (Twilio/MSG91: no field)                                                                                                                                | int/providers                                                                          |
| D18 priority inversion                       | 20 % of each provider quota reserved for CRITICAL (`delivery.criticalReservePercent`)                                                                                                                                 | int/delivery; k6 `critical_isolation` 121 s → 139 ms                                   |
| D21 overload DLQ                             | throttled-only attempts rescheduled without spending the retry budget                                                                                                                                                 | int/delivery                                                                           |
| D22 poison requeue loop                      | DLQ ingest stores only UUID ids                                                                                                                                                                                       | int/brokers                                                                            |
| D20 capped notifications (Appendix B flow 2) | CAP plan `releaseAt` (next hour / quiet end) + DIGEST job; scheduler folds 3+ into a digest, else releases with per-event caps; `CAPPED → DIGESTED/QUEUED`                                                            | int/scheduler                                                                          |
| D19 digest compliance                        | digests DND/consent re-checked at dispatch; PROMOTIONAL if any part is                                                                                                                                                | int/scheduler                                                                          |
| D25 storm dedup 409                          | window collisions → DUPLICATE (`deduplicated`); explicit keys keep 409                                                                                                                                                | int/api                                                                                |
| Compose / Docker / CI (D16, D24, DEL-02)     | Confluent Kafka 7.5 + ZooKeeper, `app`, `worker-critical`, PostgreSQL TLS (`scripts/dev-certs.sh`, `DATABASE_SSL_CA_FILE`), Redis `rename-command`; Node 20 image, npm removed, wget healthcheck; CI image-size check | **not executed**; PostgreSQL TLS verified on a throwaway local cluster                 |
| Load + EXPLAIN                               | k6 normal/peak/crash/market_crash/critical_isolation (users and symbols spread per VU/iteration); EXPLAIN on 180 724 notifications; k6 `setup_data` stripped from summaries                                           | `reports/load-*.txt`, `reports/k6-*-summary.json`, `reports/explain-delivery-rate.txt` |

Not done: APNs adapter (no APNs token stored; FCM covers iOS) — remains PARTIAL.

## Phase 8 — Documentation and final verification ✅ (2026-10-12)

- Docs: README (incl. Document Error Log), ARCHITECTURE, `docs/architecture.md`,
  `docs/database-schema.md`, `docs/sequence-diagrams/*` (3 Appendix B flows),
  `docs/performance-benchmarks.md`, DEPLOYMENT, SECURITY, RUNBOOKS, TESTING,
  TAXONOMY (table generated from the YAML), CHANGELOG (1.1.0 + AI-usage note),
  SUBMISSION (§E2 paths, owner checklist), TRACEABILITY (paths, statuses,
  summary), FINAL_GAP_ANALYSIS (D18–D25, §12, §13).
- Fixes found while verifying: `no-misused-promises` in the new digest query;
  smoke step 6 expected 3 channels but TXNX-001 is now SEBI-mandated on SMS (the
  engine was right, the script was stale); stale path comment in `rabbitmq.ts`;
  D17 dead exports removed (`DependencyUnavailableError`, `isLocale`, `Db`).
- Commands: typecheck ✅ · lint ✅ · prettier ✅ · full Jest with coverage ✅
  (see FINAL_GAP_ANALYSIS §12) · build ✅ · smoke 15/15 ✅ · OpenAPI/Postman
  regenerated · secrets scan ✅ · npm audit (0 prod) ✅.
- Graphify refresh (`/graphify . --update`, 2026-10-12): 184 changed files
  re-extracted (143 code via AST, 41 docs via 2 semantic subagents, ~221 k
  tokens), 70 deleted files pruned (old layout); graph now 1 662 nodes, 4 439
  edges, 137 communities, no import cycles. Health check: 0 dangling/missing/
  collapsed edges, 13 self-loop edges flagged. `graphify-out/` is not in
  `.gitignore` (left for the owner to decide).
- Not run: Docker/Compose/CI, real providers, full-size load scenarios.
- **No commits** were made after `504b195` (owner instruction); all of Phases
  6–8 are uncommitted working-tree changes.

## Phase 9 — Docker / Compose deployment validation ✅ (2026-10-12)

Resumed at `504b195` + uncommitted Phases 6–8 (178 working-tree entries preserved).
Docker Desktop 29.8.2 (engine 29.8.2, Compose v5.5.1, macOS arm64, 10 CPU / 8 GB);
the CLI is at `~/.docker/bin` (not on the default shell PATH). Docker had no prior
containers, images or volumes. Evidence: `reports/docker-validation.txt`,
`reports/smoke-test-docker.json`, `reports/docker-functional.json`,
`reports/test-suites-node20.txt`.

**Environment used.** `.env` (unchanged) plus a git-ignored `.local/compose.env`
(generated `POSTGRES/REDIS/RABBITMQ_PASSWORD`, `SEED=true` + `SEED_*` passwords, host
ports 15432/16379/19092/35672/3000 because the host's PostgreSQL, Redis, Kafka and
RabbitMQ already use the defaults). The existing `.local/certs/pg-server.{crt,key}`
(created by `scripts/dev-certs.sh` earlier the same day, SAN postgres/localhost) was
reused, not regenerated.

| Stage                       | Result                                                                                                                                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static config               | `docker compose config --quiet` OK (main with both env files; test file). With `.env` alone Compose refuses to start (required passwords) — intended                                                                                                                                                            |
| Image build                 | OK (~27 s). Node v20.19.6, user `node` (uid 1000), tini, npm/npx/yarn removed. Unpacked filesystem **183 MB** (< 200 MB); compressed ≈ 60 MB; Docker Desktop's containerd-store SIZE column shows 275 MB (counts compressed blobs + unpacked snapshot)                                                          |
| Container start + health    | All 11 long-running services `healthy`, `migrate` exited 0, 0 restarts, 0 OOM; app `/health/ready` all up; each worker's `/health/ready` lists its roles                                                                                                                                                        |
| Migrations / seed           | 3 migrations applied over TLS; seed: 650 templates, 1 006 users, 302 DND entries; re-runs idempotent (0 applied / 0 created)                                                                                                                                                                                    |
| Broker / store init         | Kafka topics `notification-events`/`-critical`/`-lifecycle` (6 partitions), `-dlq` (1); 3 consumer groups. RabbitMQ: 5 priority delivery queues (max-priority 10, DLX) + `delivery.dlq`, exchanges `delivery`, `dlx`. Redis DB 0, `noeviction`, AOF, AUTH required, FLUSHALL/FLUSHDB/KEYS disabled              |
| PostgreSQL TLS              | trusted CA + verify-full → TLSv1.3; plaintext → rejected; untrusted CA → `certificate verify failed`; wrong host name → rejected; every app session `ssl=true`                                                                                                                                                  |
| Smoke test                  | `npm run smoke` against the containers: **15/15**, three times (fresh, after stop/start, after down/up)                                                                                                                                                                                                         |
| Additional functional (7/7) | Redis ZSET retry member observed then delivered; quiet-hours defer; CRITICAL bypass + audit; DND blocks promotional SMS; mandatory margin call reaches a DND number; MARKET category cap; analytics (Redis realtime + delivery rates). Critical topic consumed by the critical consumer group; DND violations 0 |
| Graceful shutdown           | SIGTERM → "graceful shutdown started" → "shutdown complete", exit 0 in 0–5 s (dispatcher, events worker, API); whole-stack `stop` 8 s                                                                                                                                                                           |
| Node 20                     | `node:20.19.6-alpine` container, clean `npm ci`, no `.env`, against `docker-compose.test.yml`: typecheck/lint/format/build OK; **23/23 suites, 379/379 tests**, branches 80.67 % (statements 93.23 %, functions 92.51 %, lines 95.81 %). `jest.config.ts` loads on Node 20                                      |

**Defects found and fixed (D26–D33, see FINAL_GAP_ANALYSIS §5):**

1. PostgreSQL accepted plaintext connections (`ssl=on` does not make TLS mandatory) →
   `hba_file` with `hostssl … scram-sha-256` + `hostnossl … reject`.
2. The migration CLI ignored `DATABASE_SSL`/`DATABASE_SSL_CA_FILE` and connected in
   plaintext (hidden by 1) → `src/database/migrate.ts` parses them with `envSchema.pick`.
3. Workers inherited the image HEALTHCHECK (API port 3000) and would always be
   unhealthy → worker healthcheck on `METRICS_PORT` 9464 in the `x-app` anchor.
4. After any container restart Docker remounted tmpfs as root:0755, so the non-root
   seed failed with EACCES (`/app/.local`) and `/tmp` was unwritable → explicit tmpfs
   modes (`/tmp:mode=1777`, `/app/.local:uid=1000,gid=1000,mode=0700`); reproduced and
   verified across three restarts.
5. `docker compose down && up` put Kafka into a restart loop
   (`InconsistentClusterIdException`) because ZooKeeper used anonymous volumes →
   named `zkdata`/`zklog`; existing state recovered by copying the old anonymous volumes.
6. `stop_grace_period: 35s` (processes allow 30 s for graceful shutdown; Docker's
   default is 10 s).
7. CI image-size gate used `docker image inspect .Size`, which depends on the image
   store (275 MB on the containerd store) → measures the unpacked filesystem (`du -sxm /`).
8. Hygiene: `dev-certs.sh` silently overwrote existing certificates (now refuses unless
   `FORCE=1`); host ports overridable (`*_HOST_PORT`, Kafka advertised port follows);
   Kafka healthcheck uses the internal listener; smoke test accepts
   `SEED_CREDENTIALS_FILE`.

Files changed: `docker-compose.yml`, `.github/workflows/ci.yml`, `scripts/dev-certs.sh`,
`scripts/smoke-test.ts`, `src/database/migrate.ts`, DEPLOYMENT.md, README.md and the
four audit docs; new reports listed above. Local Node 26: typecheck, lint, prettier OK.

**Not verified:** GitHub Actions (not pushed), x86-64 images, real provider
sandboxes. **Left in place:** the Compose stack's named volumes (`pgdata`, `redisdata`,
`zkdata`, `zklog`, `kafkadata`, `rabbitdata`), unused anonymous volumes from the
images' `VOLUME` declarations and the first ZooKeeper containers, the images, and
`.local/compose.env` / `.local/compose-seed-credentials.json` (git-ignored, mode 0600).

## Phase 10 — Pre-commit audit ✅ (2026-10-14)

Resumed at `504b195` with the uncommitted Phases 6–9 (78 modified, 72 deleted,
32 untracked entries) preserved; nothing staged, committed or pushed.

| Area                    | Result                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7 functional checks     | Added to the existing e2e suite (`tests/e2e/pipeline.test.ts`, "compliance and delivery flows"), reusing its all-workers stack on `zetheta_test` / Redis DB 6 with per-run prefixes; DND test uses a unique phone. ZSET retry is asserted via a pass-through `zadd` spy (test-policy delays are 20 ms, too short to poll). 7/7 pass (Node 26 host and Node 20 container) |
| Node 20 (CI-equivalent) | `node:20.19.6-alpine`, clean `npm ci`, no `.env`, `docker-compose.test.yml`: format, lint, typecheck, build, CI migrate step, `npm audit --omit=dev` (0) OK; **23/23 suites, 386/386 tests**, statements 93.11 %, branches 81.06 %, functions 92.61 %, lines 95.62 % (`reports/test-suites-node20.txt`, `reports/coverage-summary.json`)                                 |
| Docker smoke            | Image rebuilt from the current tree; stack healthy; `npm run smoke` 15/15 (`reports/smoke-test-docker.json`); stack stopped afterwards (volumes kept)                                                                                                                                                                                                                    |
| Security                | `secrets:scan` pass (281 files); gitleaks v8.30.1 via Docker: full history (2 commits) and the exact commit set (209 files, 2.16 MB) — no leaks; no real secret value from `.env`/`.local` in the commit set (one name-based false positive: `FCM_TOKEN_URL`, a public Google URL); no real personal data (only synthetic test addresses)                                |
| Ignore rules            | `.local/compose.env`, `.local/compose-seed-credentials.json`, `.local/seed-credentials.json`, `.local/certs/*`, `.env`, `coverage/`, `dist/` ignored; nothing under `.local/` tracked. `graphify-out/` (local analysis cache with absolute paths, 4.7 MB) added to `.gitignore`                                                                                          |
| `.zetheta-project.json` | Valid JSON; all fixed fields match PDF §E3. Owner input needed: `intern_id`, `intern_name`, `intern_email`, `github_repo_url`                                                                                                                                                                                                                                            |
| CI review               | Node 20.19.6 in every job; services mirror `docker-compose.test.yml`; migrations via the TLS-aware CLI; size gate uses the unpacked filesystem                                                                                                                                                                                                                           |

**Fixed (FINAL_GAP_ANALYSIS D34–D35):** the CI `docker` job never loaded the buildx
image into the local store, so its non-root/size gate would have failed —
reproduced with a docker-container builder, fixed with `load: true` (gates then pass:
uid 1000, 183 MB); `secrets:scan` reported success after scanning 0 files when it
could not list files — now exits 2. Also: `reports/coverage-summary.json` now comes
from the Node 20 run (container paths, no local home path).

Files changed in this phase: `tests/e2e/pipeline.test.ts`, `.github/workflows/ci.yml`,
`scripts/scan-secrets.ts`, `.gitignore`, `reports/test-suites-node20.txt`,
`reports/coverage-summary.json`, `reports/smoke-test-docker.json`, docs/TESTING.md,
docs/TRACEABILITY.md, docs/FINAL_GAP_ANALYSIS.md, docs/SUBMISSION.md, this file.

Still open (classified in docs/SUBMISSION.md): consolidated PDF/xlsx, per-day
commits + transfer, metadata personal fields, first remote CI run, full 450K / 30-min
market-crash test (mandatory); provider sandboxes, Snyk, native translation review
(conditional); §B3.4 bonuses (optional).
