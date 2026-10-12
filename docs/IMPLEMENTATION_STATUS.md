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
| D14 Quiet-hours release checked caps per channel notification (one event consumed several category slots) — fixed to per event                                                                                                                                                                                                                                                            | `src/modules/scheduling/scheduler.ts`                                                         |
| DLQ classification, reason/classification filters; saga escalation `ESCALATE_MANUAL_CALL`                                                                                                                                                                                                                                                                                                 | dlq repo, ops routes, processor                                                               |
| D15 Log keys `timestamp`/`correlation_id`/`service_name`; masks `+91XXXX1234`, `s***@domain.com`; dead root-logger code removed                                                                                                                                                                                                                                                           | logger, pii, server, workers                                                                  |
| HOURLY digest frequency (PDF `digest_mode: hourly`)                                                                                                                                                                                                                                                                                                                                       | types, quiet-hours                                                                            |

Commands: `npm run typecheck` ✅, `npx jest --runInBand --forceExit` → **20/20
suites, 344/344 tests** (2026-10-12).
