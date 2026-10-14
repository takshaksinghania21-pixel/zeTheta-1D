# Provider failover — SMS provider outage (PDF Appendix B)

```mermaid
sequenceDiagram
  autonumber
  participant SW as SMS dispatcher
  participant CB as Circuit breaker (Redis Lua, shared)
  participant M as MSG91 (primary)
  participant T as Twilio (secondary)
  participant RD as Redis retry schedule
  participant AL as Prometheus / Alertmanager
  SW->>CB: acquire(MSG91)
  SW->>M: send
  M-->>SW: 503 Service Unavailable (TRANSIENT)
  SW->>CB: recordFailure — window counts 5 failures within 60 s
  SW->>T: same attempt: fail over to Twilio
  T-->>SW: accepted → SENT
  Note over SW,RD: When every provider fails: RETRYING, ZADD retry schedule with backoff (1 s, 2 s, 4 s … + jitter)
  CB->>CB: 5th failure in 60 s → CLOSED → OPEN
  CB-->>AL: delivery_provider_circuit_state{provider="msg91"} = 2 → ProviderCircuitOpen alert
  SW->>CB: acquire(MSG91) while OPEN → skipped; new SMS go straight to Twilio
  Note over CB: after 60 s OPEN → HALF_OPEN, one trial request admitted
  SW->>M: single trial
  alt trial succeeds
    SW->>CB: recordSuccess → CLOSED (MSG91 traffic resumes)
  else trial fails
    SW->>CB: recordFailure → OPEN for another 60 s
  end
```

**No duplicates during failover or recovery.** Each provider call is recorded as a
`delivery_attempts` row before it is made; once one provider accepts, the
notification moves to SENT and any later copy of the delivery message is acked as
stale (`retry` number check) — the primary does not resend it when it recovers. A
Redis lock prevents two dispatchers handling the same notification. The remaining
window is a crash _during_ a provider call: the attempt is marked `UNKNOWN` and
retried, so a duplicate is possible there (ARCHITECTURE.md §9).

**Outage detection** happens on the 5th failure within 60 s (seconds under load,
satisfying "within 30 seconds" when traffic is flowing). Non-critical SMS also have
WhatsApp as a fallback channel where the user has opted in (§B2.2).
