# Critical notification flow — RISK-001 Margin Call Warning (PDF Appendix B)

Traces a RISK-001 event from the margin engine to delivery confirmation, as
implemented. Code paths are in [docs/architecture.md](../architecture.md).

```mermaid
sequenceDiagram
  autonumber
  participant ME as Margin engine
  participant API as API POST /api/v1/events
  participant PG as PostgreSQL
  participant R as Outbox relay
  participant K as Kafka notification-critical
  participant CC as Critical consumer (own group)
  participant RD as Redis
  participant MQ as RabbitMQ delivery.sms / .push (priority 10)
  participant SW as Dispatcher (SMS)
  participant PW as Dispatcher (push)
  participant P1 as MSG91
  participant P2 as Twilio
  participant FCM as FCM
  participant WH as DLR webhook
  participant AN as Analytics consumer
  ME->>API: RISK-001 (Appendix A envelope or native), SERVICE token
  API->>PG: event + outbox row (1 tx) → 202 {notification_id, channels_targeted: [sms, push, in_app]}
  R->>K: publish reference (key = user id, x-correlation-id header)
  K->>CC: dedicated consumer group critical-consumer (not shared with notification-events)
  CC->>PG: enrich: user, contacts, preferences (Redis-cached), consents, language, timezone
  CC->>CC: classification TRANSACTIONAL → no DND scrub at routing (TRAI: transactional is exempt)
  CC->>RD: frequency caps: RISK-001 exempt → counted, never blocked (FREQUENCY_CAP_EXEMPT decision)
  CC->>CC: regulatory override: SMS + push are mandatory even if the user disabled them
  CC->>CC: quiet hours: CRITICAL → bypass with audit decision QUIET_HOURS_BYPASS
  CC->>CC: render templates in the user's language (e.g. hi), SMS ≤ 160 chars
  CC->>PG: notifications (sms, push, inapp) + history + decisions + outbox (1 tx); commit offset
  R->>MQ: one message per channel, priority 10 (highest)
  par SMS
    MQ->>SW: deliver
    SW->>RD: DND check at dispatch → DND_NOT_APPLICABLE stored with timestamp (audit proof)
    SW->>RD: circuit + rate limit (CRITICAL may use the reserved 20% of provider quota)
    SW->>P1: send
    alt MSG91 fails / circuit open
      SW->>P2: failover to Twilio (same attempt record chain, no duplicate)
    end
    SW->>PG: QUEUED → SENT
  and Push + in-app
    MQ->>PW: deliver push
    PW->>FCM: send (data.correlationId)
    PW->>PG: QUEUED → SENT
    Note over PW: The in-app copy is a separate notification delivered over Socket.IO and kept in the inbox.
  end
  P1-->>WH: signed DLR (DELIVRD)
  WH->>PG: SENT → DELIVERED (forward-only, de-duplicated)
  PG-->>AN: lifecycle events via Kafka → hourly aggregates + Redis real-time counters + latency histogram
  Note over SW,P2: All providers failing: retries (CRITICAL profile 10 × ≤ 60 s) → DLQ + WhatsApp fallback.<br/>No mandatory channel reachable at routing: DLQ entry ESCALATE_MANUAL_CALL (manual call queue).
```

**Timing.** Target < 10 s end to end (PDF). Measured on one laptop with mock
providers ([performance-benchmarks.md](../performance-benchmarks.md)): critical
event processing p99 126 ms and push send p99 139 ms while a 10× bulk load of HIGH
events was queued; ingestion p99 < 30 ms. Real provider latency is not included.

**Deviation.** The PDF lists "Call" as a RISK-001 channel; there is no IVR
provider (none is listed in Day 7 or §E1), so escalation goes to the operations
queue instead.
