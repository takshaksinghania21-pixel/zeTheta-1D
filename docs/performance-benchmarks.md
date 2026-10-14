# Performance Benchmarks

All numbers below were **measured** with the scripts in this repository on one
development laptop. They describe that machine running every role in a single
Node.js process — **not production capacity**. Raw outputs are in `reports/`.

## Environment

| Item           | Value                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware       | Apple M5, 10 cores, 16 GB RAM (macOS, darwin 27.0.0)                                                                                                     |
| Runtime        | Node.js 26.8.2, compiled build (`node dist/src/server.js`)                                                                                               |
| Topology       | **One** process running the API **and all workers** (`RUN_WORKERS=all`): relay, event + critical consumers, dispatcher, scheduler, analytics, DLQ ingest |
| Infrastructure | PostgreSQL 16.15, Redis 8, Kafka 4.3.1 (1 broker, 6 partitions), RabbitMQ 4.3.6 — same machine                                                           |
| Providers      | Mock providers (in-process, no network latency), signed receipts posted back to the same API                                                             |
| Overrides      | `LOG_LEVEL=warn`, `DATABASE_POOL_MAX=20`, API rate limits raised to 10 M/min (one load-test principal is otherwise throttled at 100/min by design)       |
| Load users     | 200 synthetic users with quiet hours off (email + push contacts, no SMS)                                                                                 |

## Rate scenarios (PDF Day 11) — `tests/load/scenarios.js`

Each run: constant arrival rate for the stated duration, then wait until every
event is processed and no notification is left in a pending state. Measured from
PostgreSQL: event processing latency (received → processed) and end-to-end send
latency (received → provider accepted). Run with
`k6 run -e SCENARIO=<name> -e DURATION=<d> … tests/load/scenarios.js`.

| Scenario (PDF)                                     | Rate         | Events | HTTP p99 | Errors | Drained after | Processing p99                | Send p99 (push)              |
| -------------------------------------------------- | ------------ | ------ | -------- | ------ | ------------- | ----------------------------- | ---------------------------- |
| normal — 2 M/day                                   | 23 /s, 60 s  | 1 381  | 6 ms     | 0 %    | 61 s          | 218 ms                        | 226 ms                       |
| peak — 10×                                         | 231 /s, 60 s | 13 861 | 8.6 ms   | 0 %    | 152 s         | 35.9 s                        | 118 s                        |
| crash — 20×                                        | 463 /s, 60 s | 27 781 | 12.7 ms  | 0 %    | 372 s         | 198 s                         | 346 s                        |
| market crash mix (§B2.1), 120 s                    | 268 /s       | 32 162 | 3.8 ms   | 0 %    | 120 s         | 258 ms                        | CRITICAL 231 ms              |
| critical isolation (10× HIGH + margin calls), 60 s | 247 /s       | 14 821 | 8.9 ms   | 0 %    | 209 s         | CRITICAL 126 ms · HIGH 41.7 s | CRITICAL 139 ms · HIGH 178 s |

Outputs: `reports/load-<scenario>.txt`, `reports/k6-<scenario>-summary.json`
(normal and peak were run before the §E2 source move and the provider-quota
reserve; their TXNX-001 path is otherwise unchanged).

### What the numbers show

- **Ingestion keeps up at 20×** (463 events/s, 0 errors, p99 12.7 ms). The API only
  validates and writes event + outbox in one transaction.
- **One process drains ≈ 100 events/s (≈ 300 notifications/s)** end to end, so at
  10× and 20× a backlog builds and drains afterwards (152 s / 372 s). Bulk HIGH
  traffic therefore waits minutes under sustained overload on this topology.
- **CRITICAL traffic is not inverted behind the backlog.** In the isolation run, margin
  calls were processed with p99 126 ms and sent with p99 139 ms while 13 860 HIGH
  events queued for up to ~3 minutes. Before the provider-quota reserve, the same run
  measured CRITICAL push p99 **121 s** (margin calls were throttled by the shared
  push quota and waited out retry delays); the fix keeps 20 % of each provider's
  quota for CRITICAL traffic.
- **Storm dedup (§B2.4).** In the market-crash mix ~30 000 raw price-alert requests
  became 2 392 unique (user, stock, minute) events; the rest were answered as
  duplicates. Most price-alert pushes were then frequency-capped as designed.
- **Overload no longer dead-letters.** The first 20× run sent 55 HIGH notifications
  to the DLQ with `LOCAL_RATE_LIMIT` after five retries — our own quota, not a
  provider failure. Throttled-only attempts now wait for quota without spending
  the retry budget.

## Scenario — 10 000-event benchmark (`npm run benchmark`)

5 000 single + 5 000 batched (`/events/batch` × 100) TXNX-001 events, 200 users,
30 000 notifications (push, email, in-app; the users have no SMS contact). Re-run after the
remediation (`reports/benchmark.json`):

| Metric                                | Measured                                |
| ------------------------------------- | --------------------------------------- |
| Events accepted / processed           | 10 000 / 10 000                         |
| `POST /events` latency (all requests) | p50 15.6 ms · p95 29.0 ms · p99 55.6 ms |
| Drained after                         | 95.8 s                                  |
| End-to-end throughput                 | ≈ 104 events/s                          |
| Event processing latency              | p50 30.7 s · p95 56.7 s · p99 59.1 s    |

Same order as before the remediation (≈ 106 events/s): switching Kafka to manual
offset commits did not measurably reduce throughput.

## Analytics and operator query latency (`tests/load/analytics.js`)

Earlier run (~42 000 notifications): 4 083 requests in 30 s (134 req/s), 0
failures, p50 25 ms · p95 338 ms · p99 360 ms. The slow tail is `percentile_cont`
over raw notifications and broker admin calls. Real-time counters
(`GET /analytics/realtime`, Redis) avoid the database entirely. Query plans:
[database-schema.md](database-schema.md#query-plans-explain-analyze).

## Not measured

- 450 000 notifications over 30 minutes (§B2.1 full size), 4.2 M multilingual
  notifications in 4 hours (§B2.5, 292/s sustained) and 150 000 simultaneous orders
  (§C1.4): scripts support them (`DURATION=30m`, `SCALE`), but the full runs were not
  executed; the single-process drain rate above (≈ 300 notifications/s) is the
  honest reference point.
- Resource consumption (CPU, memory, database IO) — no host-level profiling captured.
- Multi-instance scaling, real provider latencies, network hops between hosts.

## Capacity reasoning (NOT a measurement)

2 M/day averages 23 events/s (handled with headroom above); market-hours peaks are
the problem. Scaling path, in the order the measurements point to: run the roles as
separate processes (Compose already does: `worker-events`, `worker-critical`,
`worker-dispatch` × 2, `worker-analytics`), add dispatcher replicas (RabbitMQ
competing consumers) and event-consumer instances up to the partition count, a
dedicated outbox relay, and a larger PostgreSQL with read replicas for analytics.
None of this has been demonstrated here.

## Tuning knobs

`KAFKA_EVENT_PARTITIONS`, `KAFKA_CONSUMER_CONCURRENCY`, `RABBITMQ_PREFETCH`,
`DATABASE_POOL_MAX`, `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE`, `SCHEDULER_POLL_MS`,
dispatcher processes per channel, `delivery.criticalReservePercent`, `LOG_LEVEL`.
