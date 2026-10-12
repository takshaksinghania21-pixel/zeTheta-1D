# Final Gap Analysis — Zetheta BE-6B vs. the Assignment PDF

Authoritative specification: `493560D_Event_Driven_Notification_Engine` (74
pages). Page references are PDF page numbers. Requirement IDs refer to
[TRACEABILITY.md](TRACEABILITY.md). Progress log:
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

## 1. Executive summary

The repository is a substantial, working implementation: 293 automated tests
pass against real PostgreSQL/Redis/Kafka/RabbitMQ, the outbox/at-least-once
pipeline, consent ledger, frequency capper, quiet hours, retries/DLQ, five
provider adapters and analytics exist and are tested locally.

The audit nevertheless found that the implementation was built against a
**paraphrase** of the brief rather than the PDF itself. Where the PDF gives
concrete values or contracts, the code frequently uses its own:

- **Compliance (P0).** The DND check is performed only at routing time and is
  **not repeated at dispatch**, so quiet-hours-deferred and retried SMS are sent
  without a fresh DND check (PDF p.46 "DND check as the LAST step before SMS
  dispatch"; p.42 "Stale DND Cache" anti-pattern). The DND data was treated as
  fresh for 7 days (PDF p.14: refreshed daily). The event taxonomy contradicts
  PDF §A2 on priorities, channels and regulatory mandates (e.g. RISK-001
  mandatory on SMS+Email instead of SMS+Push; REGX-001 "SEBI Mandatory" could
  be disabled by users; MKTX-002 "CRITICAL" treated as HIGH so it was deferred by
  quiet hours), and a third `SERVICE` class let advisory/engagement events skip
  DND scrubbing although the PDF requires a TRANSACTIONAL/PROMOTIONAL split.
- **Contracts (P1).** Appendix A says "the automated assessment tool will
  validate these contracts"; the PDF's own sample `POST /api/v1/events` body
  was rejected (camelCase-only strict schema), the error envelope, preference
  and analytics endpoints and notification-status shape differed, the Kafka
  topics were not `notification-events` / `notification-critical` /
  `notification-dlq`, critical events shared one topic and consumer group with
  everything else (priority inversion risk, PDF p.36, p.67), and none of the
  nine Prometheus metric names in §A11.1 matched.
- **Verification (P1/P2).** Branch coverage is 77.70 % against an 80 %
  requirement, with the threshold configured at 70 %. Docker, CI and real
  provider sandboxes were never executed (no Docker on this machine; no
  remote; no credentials). Load tests cover a 10 000-event run only, not the
  PDF's 2 M/day, 10×, 20× and 450 k/30 min scenarios.
- **Deliverables (P1).** The mandatory `.zetheta-project.json`, the §E2 paths
  (`docs/architecture.md`, `docs/api-specification.yaml`,
  `docs/event-taxonomy.yaml`, `docs/database-schema.md`,
  `docs/sequence-diagrams/`, `docs/performance-benchmarks.md`), the simulated
  datasets (§B4), a 1 000-user seed, alerting rules and EXPLAIN ANALYZE
  evidence were missing.

Sections 5–11 classify every gap; §12 records what was fixed and verified in
this session; §13 lists what remains.

## 2. Assignment requirements and acceptance criteria

### 2.1 Mandatory, quantified acceptance criteria (from the PDF)

| Area           | Criterion                                                                                                                                                                                                                                                                         | PDF                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Taxonomy       | ≥ 25 event types in TXNX/RISK/SIPX/MKTX/REGX with the listed urgency, regulatory basis, channels, max latency                                                                                                                                                                     | p.5–8                  |
| Channels       | SMS, email, push, WhatsApp, in-app behind a `DeliveryProvider` interface (`send`, `getStatus`, `validateRecipient`, `getQuota`)                                                                                                                                                   | p.1, p.10              |
| Routing        | Regulatory override > user preference > delivery optimisation (engagement) > cost (per-user day/month budgets)                                                                                                                                                                    | p.9–10                 |
| Templates      | Handlebars, conditionals, en/hi/mr/ta/te, channel formats, versioning + A/B, English fallback, SMS ≤ 160 chars with ellipsis + link                                                                                                                                               | p.11–12, p.45          |
| Preferences    | 4 layers (system → segment → user → regulatory); GET/PUT `/users/:id/preferences`; Redis cache with invalidation; digest mode; preference analytics                                                                                                                               | p.13, p.46, p.62–64    |
| DND            | Lookup before ANY SMS, cache refreshed daily, TRANSACTIONAL vs PROMOTIONAL, check at the LAST moment before dispatch                                                                                                                                                              | p.14, p.35, p.46       |
| Caps           | 12/day (CRITICAL bypass); SMS 5, Push 8, Email 3 per day (regulatory bypass); 3/category/hour (margin calls always sent); 15-min same-type cooldown (price alerts configurable); > 8/day → suggest digest                                                                         | p.14–15                |
| Quiet hours    | 21:00–08:00 default, IANA tz, ≥ 6 h window, queue + release at window start, CRITICAL bypass with audit log, > 5 queued → morning digest                                                                                                                                          | p.15                   |
| Lifecycle      | CREATED→ENRICHED→ROUTED→QUEUED→SENT→DELIVERED→READ plus CAPPED/QUIET/DND/FAILED/RETRYING/DLQ/BOUNCED; every transition with timestamp, actor, metadata                                                                                                                            | p.16                   |
| Analytics      | 8 metrics, real-time (< 30 s lag) and historical; `/analytics/delivery-rates`, `/channel-performance`, `/opt-out-trends`                                                                                                                                                          | p.16, p.49, p.64       |
| Schema         | Core tables; monthly partitions; 5 named indexes (composite, partial, BRIN, GIN, event_type+created_at)                                                                                                                                                                           | p.17–18, p.44          |
| Retries        | `min(base·2^attempt + jitter(0,1000), max)`; CRITICAL 10/500 ms/60 s, HIGH 5/1 s/5 min, MEDIUM 3/5 s/30 min, LOW 2/30 s/2 h; Redis sorted-set scheduling                                                                                                                          | p.19, p.48             |
| Security       | JWT on all endpoints, RBAC ADMIN/OPERATOR/SERVICE, TTL ≤ 1 h, refresh rotation, strict Zod/Joi, Redis sliding-window limits 100/1000/10 per min, env secrets, PII column encryption, log masking `+91XXXX1234` / `s***@domain.com`, 90-day scrub, erasure API, webhook signatures | p.20–21                |
| Infra security | Non-root, pinned lockfile, PostgreSQL SSL, Redis AUTH + FLUSHALL/FLUSHDB/KEYS disabled, no baked secrets, resource limits                                                                                                                                                         | p.21                   |
| Observability  | `/metrics` with 9 named metrics; JSON logs with `timestamp, level, message, correlation_id, service_name`; UUID v4 correlation id through Kafka headers, logs, providers, notification record; 7 alert rules                                                                      | p.22–23                |
| Kafka          | Topics `notification-events` (keyed by user), `notification-critical` (dedicated consumer group), `notification-dlq`; idempotent producer; manual offsets; Redis TTL dedup                                                                                                        | p.44–45, p.67          |
| Testing        | ≥ 20 validator tests, ≥ 30 template tests, ≥ 25 DND/cap tests; e2e; **≥ 80 % coverage**; 100 % pass rate                                                                                                                                                                          | p.44–47, p.51–52       |
| Load           | k6/Artillery: normal 2 M/day, peak 10×, crash 20×, 450 k in 30 min; P50/P95/P99; EXPLAIN ANALYZE evidence                                                                                                                                                                         | p.49–50                |
| Delivery       | `.github/workflows/ci.yml` (lint → test → build → coverage, npm audit/Snyk); multi-stage Dockerfile < 200 MB; Compose with health checks/limits; `docker-compose.test.yml`                                                                                                        | p.51–52                |
| Repository     | Exact §E2 layout; `.zetheta-project.json`; README/ARCHITECTURE/CHANGELOG (daily log + AI usage)/DEPLOYMENT; sequence diagrams in `docs/sequence-diagrams/`; transfer to @ZethetaIntern on Day 15                                                                                  | p.43, p.52–58, p.67–69 |
| API contracts  | Appendix A request/response bodies for events, preferences, analytics, notification status (validated by an automated tool)                                                                                                                                                       | p.61–66                |

### 2.2 Optional / bonus

A13 Document Error Log (bonus); B3.4 A/B significance, preview API, send-time
optimisation, WebSocket dashboard (bonus); mutation testing ("if time permits").

### 2.3 Ambiguities and suspected deliberate errors (recorded, not invented)

The PDF states it contains five deliberate errors (p.25). Candidates found, with
the interpretation adopted:

1. **Schema — partitioned PK (p.17).** `notifications.id UUID PRIMARY KEY` on a
   table `PARTITION BY RANGE (created_at)` is invalid in PostgreSQL (unique
   constraints on a partitioned table must include the partition key), which
   also makes `dead_letter_queue.notification_id REFERENCES notifications(id)`
   impossible. Implementation: PK `(id, created_at)`; logical dedupe in
   `notification_keys`; DLQ references by id without FK. _High confidence._
2. **Schema — expression in PRIMARY KEY (p.13).** `PRIMARY KEY (user_id,
event_category, COALESCE(event_type,'*'), channel)` is not valid SQL; it
   must be a unique expression index. _High confidence._
3. **Retry parameters (p.19).** The worked examples ("Attempt 1: ~1–2 s")
   contradict the formula `baseDelay·2^attempt` (attempt 1 = 2–3 s), the
   priority table skips priority 4 although the schema allows 1–5, and
   CRITICAL's 10 retries up to 60 s each run for minutes — incompatible with the
   < 10 s margin-call objective unless failover/fallback channels are used
   in parallel. Implementation keeps the table values (they are the explicit
   requirement) and uses provider failover + fallback channels for CRITICAL.
   _Medium confidence on which item is the deliberate error._
4. **Taxonomy (p.8 vs p.29).** REGX-005 "Regulatory Policy Change" is LOW /
   "< 24 hours", yet Challenge 5 requires a REGX-005 to reach every user within
   4 hours. Implementation follows §A2 (LOW, 24 h objective) and documents the
   conflict. _Medium confidence._
5. **Frequency caps (p.14–15).** The per-channel daily caps sum to 16, which
   exceeds the global cap of 12, and the digest threshold "> 8/day" is attached
   to a "rolling 7 days" window; also the quiet-hours digest threshold (> 5,
   p.15) differs from Appendix B's "3+ capped notifications" (p.68).
   Implementation: all caps enforced independently (the global cap wins), digest
   suggestion when the 7-day average exceeds 8/day, morning digest when > 5.
   _Medium confidence._
6. **API (p.61–66).** `user_id: "usr_<uuid>"` / `notification_id: "ntf_<uuid>"`
   contradict the UUID columns of §A8; `PUT` is used for a partial (per-category)
   update (PATCH semantics); the 202 ingestion response returns a single
   `notification_id` although one event fans out to one notification per channel
   (§A8 `notifications.channel`). Implementation accepts both prefixed and bare
   UUIDs, keeps `PUT` as specified, and returns the event's request id as the
   tracking id. _Medium confidence._

Other ambiguities: the "Call"/IVR channel listed for RISK-001/002 (p.6) has no
provider task in Day 7 and no stack entry in §E1; Appendix A's
`regulatory_overrides` sample omits "Call". Quiet hours: the PDF does not say
whether email/in-app are deferred; the implementation defers intrusive
channels (SMS, push, WhatsApp) only.

## 3. Graphify-based architecture findings

Graph: 1 473 nodes / 3 996 edges / 83 communities (see
`graphify-out/GRAPH_REPORT.md`). Each finding below was verified in source.

| #   | Graph signal                                                                                                                                                                                                  | Verified finding                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `Container` (39 edges) and `Channel` (71) are god nodes; ingestion → outbox → Kafka → `EventProcessor` → `RoutingEngine` → factory → outbox → RabbitMQ → `DeliveryDispatcher` → providers forms one hyperedge | Clean layered pipeline; the API, processor and dispatcher do not call each other directly (correct separation, PDF B3.1).                                                   |
| G2  | `topicNames()` has exactly three outputs; only `financialEvents` and `lifecycle` have consumers                                                                                                               | Single ingestion topic + single consumer group for all priorities; **the Kafka DLQ topic is created but never produced to** (dead topic). No `notification-critical` topic. |
| G3  | `DeliveryDispatcher.recheck()` links to `evaluateConsent` and `channelsForEvent` but not to `evaluateDnd`/`DndService`                                                                                        | **DND is not re-checked at dispatch (P0).**                                                                                                                                 |
| G4  | `RedisBudgetTracker` keys are `budget:<channel>:<day>`                                                                                                                                                        | Budgets are global per channel per day, not per user per day/month (PDF p.10).                                                                                              |
| G5  | `UserRepository.getPreferences` has no edge to Redis                                                                                                                                                          | No preference cache (PDF p.46).                                                                                                                                             |
| G6  | `src/modules/analytics/service.ts` has no Redis edges                                                                                                                                                         | Analytics are PostgreSQL hourly aggregates; no Redis real-time counters (PDF p.49).                                                                                         |
| G7  | Exported-but-unreferenced symbols                                                                                                                                                                             | Dead code: `DependencyUnavailableError`, `getLogger`, `isLocale`, type `Segment`, type `Db`.                                                                                |
| G8  | `computeRetryDelay` → `retryBand` → RabbitMQ retry exchange                                                                                                                                                   | Retries are scheduled via RabbitMQ TTL delay-band queues, not Redis sorted sets (PDF p.48). Functionally durable; a documented deviation.                                   |
| G9  | `CircuitBreaker` state is `consecutiveFailures`                                                                                                                                                               | Breaker trips on 5 _consecutive_ failures, opens for 30 s; PDF: 5 failures in a 60 s window, 60 s open (p.68).                                                              |
| G10 | Docs community "Architecture Docs" references `financial-events.v1`, `/api/docs`                                                                                                                              | Architecture docs consistent with code but both inconsistent with the PDF names.                                                                                            |
| G11 | No import cycles detected                                                                                                                                                                                     | —                                                                                                                                                                           |
| G12 | Test communities link to every module except `AnalyticsService` branches, `scheduler` digest paths, provider adapters' error mapping                                                                          | Matches the uncovered-branch report (§9).                                                                                                                                   |

## 4. Requirement-by-requirement gap summary

See [TRACEABILITY.md](TRACEABILITY.md) for the full matrix (requirement, PDF
page, implementation, tests, baseline and current status, evidence, remaining
work). Counts are in §12.

## 5. Confirmed defects

| ID  | Pri | Defect                                                                                                                                                                                                                                | Why this priority                                                                                               | Evidence                                                              |
| --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| D1  | P0  | DND not re-checked at SMS dispatch; deferred/retried SMS skip DND                                                                                                                                                                     | TRAI compliance; the PDF's headline failure is 12 847 DND violations                                            | `dispatcher.ts` `recheck()` evaluates status/preferences/consent only |
| D2  | P0  | DND data considered fresh for 7 days (`DND_STALE_AFTER_HOURS=168`)                                                                                                                                                                    | PDF: refresh daily; C3.2 root cause "updated weekly instead of daily"                                           | `src/config/env.ts`                                                   |
| D3  | P0  | Taxonomy contradicts §A2/Appendix A: mandatory channels (RISK-001 sms+email instead of sms+push; REGX-001, TXNX-001/002, RISK-003, MKTX-002 not mandatory), priorities (SIPX-002, MKTX-002/004/005, REGX-005), channels for 18 events | SEBI-mandated notifications could be disabled by users; CRITICAL circuit-breaker alerts deferred by quiet hours | `config/event-taxonomy.yaml`                                          |
| D4  | P0  | Third regulatory class `SERVICE` bypassed DND for advisory/engagement events (RISK-004/005, SIPX-005, MKTX-003, …)                                                                                                                    | PDF requires TRANSACTIONAL vs PROMOTIONAL; misclassification is C3.2's root cause                               | taxonomy + `policy.dnd.appliesToClasses`                              |
| D5  | P1  | Appendix A sample `POST /api/v1/events` rejected (camelCase strict schema); response/error envelope differ                                                                                                                            | Automated contract validation                                                                                   | `eventEnvelopeSchema`                                                 |
| D6  | P1  | Single Kafka topic/consumer group for all priorities; topic names differ; DLQ topic unused; autoCommit                                                                                                                                | PDF p.36, p.44, p.67                                                                                            | `kafka.ts`, `workers.ts`                                              |
| D7  | P1  | Prometheus metric names/labels differ from §A11.1; no DND-block counter                                                                                                                                                               | Assessment scrapes named metrics                                                                                | `metrics.ts`                                                          |
| D8  | P1  | Coverage threshold 70 % branches; actual 77.70 %                                                                                                                                                                                      | PDF p.51 requires 80 %                                                                                          | `jest.config.js`                                                      |
| D9  | P1  | A8.2 indexes missing (composite user/status/channel, BRIN created_at, event_type+created_at, GIN)                                                                                                                                     | "Your schema must include"                                                                                      | migration                                                             |
| D10 | P1  | Circuit breaker: consecutive-failure count, 30 s open                                                                                                                                                                                 | Appendix B 5-in-60 s, 60 s open                                                                                 | `notification-policy.yaml`, `circuit-breaker.ts`                      |
| D11 | P1  | SMS allowed up to 4 segments                                                                                                                                                                                                          | PDF: SMS body must fit 160 chars, ellipsis + link                                                               | `smsMaxSegments: 4`                                                   |
| D12 | P1  | Price-alert storm dedup keyed on exact `triggeredAt` — duplicates with different timestamps pass                                                                                                                                      | B2.4 requires (event_type + entity + timestamp window)                                                          | taxonomy `idempotencyKeyFields`                                       |
| D13 | P1  | Swagger at `/api/docs`, no `/health` aggregate                                                                                                                                                                                        | PDF p.50–51 paths                                                                                               | `app.ts`                                                              |
| D14 | P2  | Digest suggestion after 5 cap hits/7 days                                                                                                                                                                                             | PDF: > 8 notifications/day                                                                                      | policy                                                                |
| D15 | P2  | Log masking formats `+**********1234`, `a***@***.com`; log keys `correlationId`/`service`                                                                                                                                             | PDF p.20, p.22 exact formats/keys                                                                               | `pii.ts`, `logger.ts`                                                 |
| D16 | P2  | Compose: no PostgreSQL SSL; Redis dangerous commands not disabled                                                                                                                                                                     | PDF p.21                                                                                                        | `docker-compose.yml`                                                  |
| D17 | P3  | Dead code (G7)                                                                                                                                                                                                                        | Hygiene                                                                                                         | —                                                                     |

## 6. Partially implemented requirements

- Routing optimisation by per-user engagement history (A3.2 P3) — not used in routing.
- Cost budgets per user per day/month (A3.2 P4) — global per-channel only.
- Template A/B testing (Day 4) — versioning exists, no A/B split.
- Preference caching in Redis + preference analytics (Day 5).
- Redis TTL event dedup (Day 3) — dedup is durable in PostgreSQL instead.
- Retry scheduling with Redis sorted sets (Day 9) — RabbitMQ delay bands instead.
- DLQ classification transient/permanent/configuration (Day 9) and DLQ alerting rules.
- FCM → APNS failover (Day 8) — no APNS adapter.
- Escalation to a manual call queue / "Call" channel (A1.2, A2.3).
- Real-time analytics counters in Redis (Day 10); BRIN-optimised analytics queries.
- `user_preferences` stored as a versioned JSON document rather than the §A5.2 row model; table names differ from §A8 (`notification_state_history`, `dead_letter_entries`, `provider_configs`).
- Repository layout differs from §E2 (`src/modules/*` instead of `src/events`, `src/notifications`, …; `jest.config.js` instead of `.ts`; no top-level `migrations/`).
- Correlation id forwarded to providers only via SMTP header.
- CHANGELOG has no daily log (work done in one session; history must not be fabricated) and no AI-usage notes.

## 7. Unverified requirements

- Docker image build/size (< 200 MB), Compose start-up, non-root runtime — Docker unavailable.
- GitHub Actions CI — never executed (no remote).
- Real provider sandboxes (MSG91, Twilio, FCM, WhatsApp Cloud, Ethereal) — no credentials; adapters verified against local stubs/SMTP only.
- Throughput at 2 M/day, 10×, 20×, 450 k/30 min, 292/s multilingual — not run.
- Repository name `BE-6B-NotificationEngine-[Name]`, privacy, transfer to @ZethetaIntern — owner actions.

## 8. Security and compliance concerns

- D1–D4 (compliance) above.
- Local Redis runs without AUTH (development only); Compose sets `requirepass`.
- Machine-assisted hi/mr/ta/te translations have not had native review; legal
  copy (margin calls, KYC) must be reviewed before production.
- Regulatory classification of borderline events requires human compliance
  review (PDF C3.3 itself requires it) — see docs/TAXONOMY.md.
- At-least-once delivery: a crash after a provider accepted a message but before
  the attempt row is updated can resend once on recovery only when the provider
  did not return an id; documented in ARCHITECTURE.md §9.

## 9. Testing and performance gaps

- Branch coverage 77.70 % (< 80 %); lowest files: provider adapters' error
  mapping, analytics service, scheduler digest/retention branches, ops routes.
- No load scenarios for 2 M/day, 10×, 20×, market crash; existing 10 k-event
  run showed critical latency objectives **not met** under a single-process
  burst (event processing p95 48.9 s), which a dedicated critical topic is
  meant to address.
- No EXPLAIN ANALYZE evidence for the daily delivery-rate query (A12 Q5, Day 11).

## 10. Infrastructure and deployment gaps

- Docker/Compose/CI unexecuted (environment).
- Compose uses `apache/kafka` (KRaft) instead of Confluent images + ZooKeeper
  (Appendix C); PostgreSQL 16 / RabbitMQ 4.3 images satisfy "15+" / "3.12+".
- No PostgreSQL SSL, no Redis command renaming (D16); no alert-rules file.
- Local runtime is Node 26 (PDF: Node 20 LTS); the image uses Node 20.

## 11. Prioritised remediation plan

| Order | Item                    | Pri   | Approach (smallest maintainable change)                                                                                                                                     |
| ----- | ----------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | D1 DND at dispatch      | P0    | Re-run `evaluateDnd` in `recheck()`; allow QUEUED/RETRYING → DND; persist the dispatch-time decision (audit proof)                                                          |
| 2     | D2 DND freshness        | P0    | Default `DND_STALE_AFTER_HOURS=24`                                                                                                                                          |
| 3     | D3/D4 taxonomy          | P0    | Realign YAML with §A2 + Appendix A; binary classification; mandatory channels for SEBI-mandated events; CRITICAL ⇒ quiet-hours bypass                                       |
| 4     | D6 Kafka                | P1    | PDF topic names; critical topic + dedicated consumer group; produce to `notification-dlq`; manual offset commits                                                            |
| 5     | D5 Appendix A contracts | P1    | Accept the snake_case envelope; add PDF fields to responses; `VALIDATION_FAILED` envelope; PUT `/preferences`; analytics aliases; notification `state_history`/`compliance` |
| 6     | D7 metrics              | P1    | Rename/add metrics per §A11.1                                                                                                                                               |
| 7     | D9 indexes              | P1    | New migration                                                                                                                                                               |
| 8     | D10–D13                 | P1    | Policy values, SMS limit, dedup window, `/api-docs`, `/health`                                                                                                              |
| 9     | D8 coverage             | P1    | Tests for uncovered branches; threshold 80 %                                                                                                                                |
| 10    | Deliverables            | P1    | `.zetheta-project.json`, §E2 docs paths, sequence diagrams, datasets script, 1 000-user seed, alert rules, Document Error Log                                               |
| 11    | D14–D16                 | P2    | Policy/format fixes; Compose SSL + rename-command                                                                                                                           |
| 12    | Partial items §6        | P2/P3 | Implement where small; otherwise document                                                                                                                                   |

## 12. Final verification results

_Filled in at the end of the session (Phase 8)._

## 13. Remaining limitations and submission risks

_Filled in at the end of the session (Phase 8)._
