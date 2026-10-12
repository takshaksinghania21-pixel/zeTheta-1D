# Performance and Load Testing

All numbers below were **measured** on 2026-10-11 with the scripts in this
repository. They describe one development laptop, not production capacity.

## Environment

| Item                  | Value                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware              | Apple M5, 10 cores, 16 GB RAM (macOS, darwin 27.0.0)                                                                                                                                                                |
| Runtime               | Node.js 26.8.2, compiled build (`node dist/src/server.js`)                                                                                                                                                          |
| Topology              | **One** Node process running the API **and all workers** (`RUN_WORKERS=all`): outbox relay, event consumer (3 partitions in parallel), dispatcher (5 channel queues, prefetch 20), scheduler, analytics, DLQ ingest |
| Infrastructure        | PostgreSQL 16.15, Redis 8.10, Kafka 4.3.1 (1 broker, 6 partitions), RabbitMQ 4.3.6 — all on the same machine                                                                                                        |
| Providers             | Mock providers (in-process), signed receipts posted back to the same API                                                                                                                                            |
| Overrides for the run | `LOG_LEVEL=warn`, `DATABASE_POOL_MAX=20`, `RATE_LIMIT_STANDARD_PER_MIN` and `RATE_LIMIT_WEBHOOK_PER_MIN` raised to 10 000 000 (otherwise the single load-test principal is throttled at 100 req/min by design)      |

## Scenario 1 — 10 000-event ingestion + end-to-end processing

Command (requires running stack + seeded credentials):

```bash
EVENTS=10000 VUS=50 BENCH_USERS=200 npx tsx scripts/benchmark.ts
```

Workload: 200 synthetic users; 5 000 single `POST /events` (50 VUs) +
5 000 events via 50 `POST /events/batch` calls of 100 (10 VUs). Event type
`TXNX-001` → 3 notifications per event (push, email, in-app) → 30 000
notifications. Raw outputs: `reports/benchmark.json`,
`reports/k6-ingestion-summary.json`, `reports/k6-ingestion-output.txt`.

| Metric                                                  | Measured                                                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Events accepted / rejected                              | 10 000 / 0                                                                                             |
| HTTP requests                                           | 5 051 in 2.98 s (≈ 1 996 req/s)                                                                        |
| Ingestion throughput                                    | ≈ 3 950 events/s (single + batch combined)                                                             |
| HTTP error rate                                         | 0.00 %                                                                                                 |
| `POST /events` latency                                  | p50 14.6 ms · p95 22.4 ms · p99 75.7 ms (all requests); single-event scenario p95 21.7 ms, p99 29.2 ms |
| `POST /events/batch` (100 events)                       | p50 272 ms · p95 1.41 s                                                                                |
| Events processed                                        | 10 000 / 10 000                                                                                        |
| Notifications sent                                      | 30 000 / 30 000; none left pending                                                                     |
| Time until fully drained                                | 94.6 s from start of ingestion                                                                         |
| Sustained end-to-end throughput                         | ≈ 106 events/s ≈ 317 notifications/s                                                                   |
| Event processing latency (received → processed)         | p50 25.8 s · p95 48.9 s · p99 51.2 s                                                                   |
| Notification send latency (created → provider accepted) | p50 17 ms · p95 50.8 s · p99 55.7 s                                                                    |
| Errors in server log                                    | 0                                                                                                      |

**Interpretation.** Ingestion is ~37× faster than processing in this topology,
so the burst of 10 000 events queued in Kafka/RabbitMQ; the multi-second
processing latencies are queueing delay, not per-item cost (once picked up,
p50 send latency is 17 ms). The single process shares one event loop and one
20-connection DB pool between the API, consumer, dispatcher, relay and
receipt webhooks (60 000 extra webhook calls). The latency objectives in the
taxonomy (e.g. 10 s for margin calls) are therefore **not met under this
synthetic overload**; they are met at steady low load (e2e tests deliver in
< 1 s).

## Scenario 2 — analytics and operator query latency

```bash
k6 run -e BASE_URL=http://localhost:3000 -e USERNAME=operator -e PASSWORD=… -e VUS=10 -e DURATION=30s tests/load/analytics.js
```

With ~42 000 notifications and ~130 000 history rows in the database:

| Metric   | Measured                                                      |
| -------- | ------------------------------------------------------------- |
| Requests | 4 083 in 30 s (134 req/s), 0 failures                         |
| Latency  | p50 25 ms · p90 312 ms · p95 338 ms · p99 360 ms · max 367 ms |

Endpoints rotated: `/analytics/summary`, `/analytics/latency`,
`/analytics/delivery?groupBy=eventType`, `/notifications?limit=50`,
`/ops/queues`. The slow tail is `percentile_cont` over `notifications` (latency
endpoint) and RabbitMQ/Kafka admin calls (`/ops/queues`).

## Not measured

- Database CPU/IO utilisation (no host-level profiling was captured).
- Failure-recovery under load (provider outage while loaded) — recovery
  behaviour is covered functionally by tests, not benchmarked.
- Multi-instance scaling, real provider latencies, network hops between hosts.

## Capacity estimate (NOT a measurement)

The assignment discusses millions of notifications per day. One million per
day is ~12/s average; peaks around market open/close are much higher. The
measured single-process figure (~317 notifications/s sustained, all roles on
one event loop) suggests the architecture can reach that order of magnitude
by scaling the stateless roles independently — e.g. several dispatcher
processes (RabbitMQ competing consumers), event consumers up to the partition
count, a dedicated relay, and a larger PostgreSQL. This has **not** been
demonstrated; it requires a multi-node test with production-like
infrastructure.

## Tuning knobs

`KAFKA_EVENT_PARTITIONS`, `KAFKA_CONSUMER_CONCURRENCY`, `RABBITMQ_PREFETCH`,
`DATABASE_POOL_MAX`, `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE`, number of
dispatcher processes (`DISPATCH_CHANNELS` to dedicate processes to channels),
`LOG_LEVEL`.
