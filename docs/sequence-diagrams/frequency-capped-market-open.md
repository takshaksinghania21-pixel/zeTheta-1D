# Non-critical flow with frequency capping — MKTX-003 Market Open (PDF Appendix B)

```mermaid
sequenceDiagram
  autonumber
  participant MD as Market data feed
  participant API as API
  participant K as Kafka notification-events
  participant EC as Event consumer (shared group event-consumer)
  participant RD as Redis (capper Lua)
  participant PG as PostgreSQL
  participant SCH as Scheduler
  MD->>API: MKTX-003 Market Open
  API->>K: via outbox (key = user id)
  K->>EC: standard consumer group, lower priority than notification-critical
  EC->>PG: enrich user context (preferences, consents, engagement history)
  EC->>EC: PROMOTIONAL (Engagement) → push needs explicit opt-in
  EC->>RD: global daily cap 12 — user at 8 → allowed, budget reduced
  EC->>RD: per-category hourly cap 3 — 3 MKTX already in the last hour → BLOCK (one atomic Lua call)
  EC->>PG: push → CAPPED with reason FREQUENCY_CAP_CATEGORY and scheduledFor = next hour window
  EC->>PG: scheduled DIGEST job at that time (one per user per window)
  Note over EC: If the next window falls inside quiet hours, scheduledFor = end of quiet hours (morning).
  SCH->>PG: job due
  alt user has 3+ capped events waiting
    SCH->>PG: fold them into one digest push (CAPPED → DIGESTED), queue the digest
  else fewer than 3
    SCH->>RD: re-check caps; allowed → CAPPED → QUEUED, still blocked → stays CAPPED (final)
  end
```

**Race: a CRITICAL event arrives while a non-critical one is being cap-evaluated.**
The two never contend in a way that delays the critical one: CRITICAL events are on
`notification-critical` with their own consumer group and worker, so they are not
queued behind the non-critical event. Cap evaluation is a single Redis Lua script
per user, so the two evaluations are serialised atomically and neither sees a
half-updated window. CRITICAL events are cap-exempt: they are _counted_ (and can
therefore consume budget that a concurrent non-critical event would have used) but
are never blocked. Re-delivery of either event replays the original outcome because
the script is idempotent per event id.
