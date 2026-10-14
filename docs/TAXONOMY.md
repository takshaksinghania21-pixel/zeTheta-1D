# Financial Event Taxonomy

Source of truth: [`config/event-taxonomy.yaml`](../config/event-taxonomy.yaml).
Loaded and validated at startup by `src/events/models/taxonomy.ts`. Byte-identical
copies live at `docs/event-taxonomy.yaml` and `src/events/taxonomy.yaml` (PDF §E2
layout); `tests/unit/taxonomy.test.ts` fails if they drift.

## Provenance

Every event carries a comment with its PDF §A2 row. The YAML `provenance` block
records the source of each field:

| Field                                                                                                   | Source                                                         |
| ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Codes, names, categories, priority (urgency), channels, latency objectives                              | **Assignment** §A2 (p. 5–8)                                    |
| Mandatory channels ("SEBI Mandatory" / "Exchange Mandate")                                              | **Assignment** §A2 + Appendix A `regulatory_overrides` (p. 63) |
| Quiet-hours bypass for CRITICAL only                                                                    | **Assignment** §A6.3                                           |
| TRANSACTIONAL / PROMOTIONAL class, cap exemptions, fallback channels, schedule-type latency → objective | **Default** chosen here; needs compliance review (PDF §C3.3)   |
| Frequency caps (12/day, per-channel, 3 per category per hour), quiet hours 21:00–08:00, retry profiles  | **Assignment** (in `config/notification-policy.yaml`)          |

In-app is added to every event (the in-app feed, Appendix A/B). The classification
is binary, as in the PDF: the loader rejects any other class. Advisory/engagement
content that suggests an action is PROMOTIONAL.

## Events

Generated from the YAML.

| Code     | Name                     | Priority | Class         | Default channels        | Mandatory        | Latency objective | Quiet hours | Cap-exempt                      |
| -------- | ------------------------ | -------- | ------------- | ----------------------- | ---------------- | ----------------- | ----------- | ------------------------------- |
| TXNX-001 | Buy Order Executed       | HIGH     | TRANSACTIONAL | sms, push, email, inapp | sms, push, email | 30 s              | defer       | yes                             |
| TXNX-002 | Sell Order Executed      | HIGH     | TRANSACTIONAL | sms, push, email, inapp | sms, push, email | 30 s              | defer       | yes                             |
| TXNX-003 | Order Rejected           | HIGH     | TRANSACTIONAL | push, sms, inapp        | –                | 15 s              | defer       | yes                             |
| TXNX-004 | Dividend Credited        | MEDIUM   | TRANSACTIONAL | email, push, inapp      | –                | 1 h               | defer       | no                              |
| TXNX-005 | Funds Deposited          | HIGH     | TRANSACTIONAL | sms, push, inapp        | –                | 1 min             | defer       | yes                             |
| RISK-001 | Margin Call Warning      | CRITICAL | TRANSACTIONAL | sms, push, inapp        | sms, push        | 10 s              | **bypass**  | yes                             |
| RISK-002 | Margin Shortfall         | CRITICAL | TRANSACTIONAL | sms, push, email, inapp | sms, push, email | 5 s               | **bypass**  | yes                             |
| RISK-003 | Position Squared Off     | CRITICAL | TRANSACTIONAL | sms, push, email, inapp | sms, push, email | 15 s              | **bypass**  | yes                             |
| RISK-004 | Portfolio Risk Alert     | HIGH     | TRANSACTIONAL | push, email, inapp      | –                | 5 min             | defer       | no                              |
| RISK-005 | Concentration Alert      | MEDIUM   | PROMOTIONAL   | email, inapp            | –                | 1 h               | defer       | no                              |
| SIPX-001 | SIP Due Reminder         | MEDIUM   | TRANSACTIONAL | push, whatsapp, inapp   | –                | 1 h               | defer       | no                              |
| SIPX-002 | SIP Executed             | HIGH     | TRANSACTIONAL | sms, email, inapp       | –                | 2 h               | defer       | yes                             |
| SIPX-003 | SIP Failed               | HIGH     | TRANSACTIONAL | sms, push, email, inapp | –                | 30 min            | defer       | yes                             |
| SIPX-004 | SIP Step-Up Reminder     | LOW      | PROMOTIONAL   | email, inapp            | –                | 24 h              | defer       | no                              |
| SIPX-005 | Goal Milestone Reached   | LOW      | PROMOTIONAL   | push, inapp             | –                | 4 h               | defer       | no                              |
| MKTX-001 | Price Alert Triggered    | HIGH     | TRANSACTIONAL | push, sms, inapp        | –                | 15 s              | defer       | no (cooldown 15 min per symbol) |
| MKTX-002 | Circuit Breaker Hit      | CRITICAL | TRANSACTIONAL | push, sms, inapp        | push, sms        | 10 s              | **bypass**  | yes                             |
| MKTX-003 | Market Open/Close        | LOW      | PROMOTIONAL   | push, inapp             | –                | 1 min             | defer       | no                              |
| MKTX-004 | 52-Week High/Low         | MEDIUM   | PROMOTIONAL   | push, email, inapp      | –                | 30 min            | defer       | no                              |
| MKTX-005 | Earnings Announcement    | MEDIUM   | PROMOTIONAL   | email, inapp            | –                | 24 h              | defer       | no                              |
| REGX-001 | KYC Expiry Warning       | HIGH     | TRANSACTIONAL | sms, email, push, inapp | sms, email       | 24 h              | defer       | yes                             |
| REGX-002 | Nominee Update Reminder  | MEDIUM   | TRANSACTIONAL | email, push, inapp      | –                | 24 h              | defer       | yes                             |
| REGX-003 | Contract Note Generated  | HIGH     | TRANSACTIONAL | email, inapp            | email            | 24 h              | defer       | yes                             |
| REGX-004 | Tax Statement Available  | MEDIUM   | TRANSACTIONAL | email, inapp            | –                | 24 h              | defer       | yes                             |
| REGX-005 | Regulatory Policy Change | LOW      | TRANSACTIONAL | email, inapp            | –                | 24 h              | defer       | no                              |

Quiet hours only defer intrusive channels (`sms`, `push`, `whatsapp`); email and
in-app are delivered immediately. Payload fields, types and constraints per
event are in the YAML and exposed at `GET /api/v1/taxonomy/events`.

## Validation guarantees (enforced at load time)

- Codes match `ABCD-123`, are unique and use their category prefix.
- Default, fallback and mandatory channels ⊆ permitted channels.
- Only TRANSACTIONAL and PROMOTIONAL classes are accepted.
- Promotional events cannot have mandatory channels, bypass quiet hours, or be
  cap-exempt; only CRITICAL events may bypass quiet hours (no blanket override).
- Idempotency and cooldown key fields must be required payload fields.
- Payload schemas are strict (unknown fields rejected); money is decimal
  strings (no float arithmetic); URLs must be https; datetimes need an offset.

## Adding an event type

1. Append the definition to `config/event-taxonomy.yaml` and copy the file to
   `docs/event-taxonomy.yaml` and `src/events/taxonomy.yaml`.
2. Add `title/short/long` templates to `templates/en.yaml` (required) and other
   locales (optional — English is the fallback).
3. Add a sample payload to `src/events/models/fixtures.ts`.
4. `npm test` (taxonomy, template-coverage and rendering tests run for every
   event automatically), then `npm run seed` (or `POST /api/v1/templates`) to
   load templates into the database.

No routing, compliance, scheduling or delivery code changes are needed.
