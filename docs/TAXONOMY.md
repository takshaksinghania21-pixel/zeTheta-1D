# Financial Event Taxonomy

Source of truth: [`config/event-taxonomy.yaml`](../config/event-taxonomy.yaml).
Loaded and validated at startup by `src/modules/taxonomy/taxonomy.ts`.

## Provenance

| Field                                                                                                                                                                                            | Source                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Event codes, names, the five categories                                                                                                                                                          | **Assignment** (BE-6B brief)                                                                              |
| Priority, regulatory class, permitted/default/fallback channels, mandatory channels, latency objectives, quiet-hours behaviour, cap exemptions, payload schemas, idempotency/cooldown key fields | **Application defaults** chosen for this implementation — not regulatory mandates; review with compliance |
| Retry profiles per priority, frequency-cap limits, quiet-hours default 21:00–08:00, 6-hour minimum, digest threshold > 5                                                                         | **Assignment** (in `config/notification-policy.yaml`)                                                     |

## Events

| Code     | Name                     | Priority | Class         | Default channels        | Mandatory  | Quiet hours                             | Cap-exempt               |
| -------- | ------------------------ | -------- | ------------- | ----------------------- | ---------- | --------------------------------------- | ------------------------ |
| TXNX-001 | Buy Order Executed       | HIGH     | TRANSACTIONAL | push, email, inapp      | –          | defer                                   | yes                      |
| TXNX-002 | Sell Order Executed      | HIGH     | TRANSACTIONAL | push, email, inapp      | –          | defer                                   | yes                      |
| TXNX-003 | Order Rejected           | HIGH     | TRANSACTIONAL | push, sms, inapp        | –          | defer                                   | yes                      |
| TXNX-004 | Dividend Credited        | MEDIUM   | TRANSACTIONAL | email, inapp            | –          | defer                                   | no                       |
| TXNX-005 | Funds Deposited          | HIGH     | TRANSACTIONAL | push, sms, inapp        | –          | defer                                   | yes                      |
| RISK-001 | Margin Call Warning      | CRITICAL | TRANSACTIONAL | sms, push, email, inapp | sms, email | **bypass**                              | yes                      |
| RISK-002 | Margin Shortfall         | CRITICAL | TRANSACTIONAL | sms, push, email, inapp | sms, email | **bypass**                              | yes                      |
| RISK-003 | Position Squared Off     | CRITICAL | TRANSACTIONAL | sms, push, email, inapp | sms, email | **bypass**                              | yes                      |
| RISK-004 | Portfolio Risk Alert     | HIGH     | SERVICE       | push, inapp             | –          | defer                                   | no                       |
| RISK-005 | Concentration Alert      | MEDIUM   | SERVICE       | push, inapp             | –          | defer                                   | no                       |
| SIPX-001 | SIP Due Reminder         | MEDIUM   | SERVICE       | push, email, inapp      | –          | defer                                   | no                       |
| SIPX-002 | SIP Executed             | MEDIUM   | TRANSACTIONAL | email, inapp            | –          | defer                                   | no                       |
| SIPX-003 | SIP Failed               | HIGH     | TRANSACTIONAL | push, sms, email, inapp | –          | defer                                   | yes                      |
| SIPX-004 | SIP Step-Up Reminder     | LOW      | PROMOTIONAL   | push, email, inapp      | –          | defer                                   | no                       |
| SIPX-005 | Goal Milestone Reached   | LOW      | SERVICE       | push, inapp             | –          | defer                                   | no                       |
| MKTX-001 | Price Alert Triggered    | HIGH     | SERVICE       | push, inapp             | –          | defer                                   | no (cooldown per symbol) |
| MKTX-002 | Circuit Breaker Hit      | HIGH     | SERVICE       | push, inapp             | –          | defer                                   | no (cooldown per symbol) |
| MKTX-003 | Market Open/Close        | LOW      | SERVICE       | inapp                   | –          | defer                                   | no                       |
| MKTX-004 | 52-Week High/Low         | LOW      | PROMOTIONAL   | push, inapp             | –          | defer                                   | no                       |
| MKTX-005 | Earnings Announcement    | LOW      | PROMOTIONAL   | email, inapp            | –          | defer                                   | no                       |
| REGX-001 | KYC Expiry Warning       | HIGH     | SERVICE       | email, sms, inapp       | –          | defer                                   | no                       |
| REGX-002 | Nominee Update Reminder  | MEDIUM   | SERVICE       | email, inapp            | –          | defer                                   | no                       |
| REGX-003 | Contract Note Generated  | HIGH     | TRANSACTIONAL | email, inapp            | email      | defer (email/in-app are never deferred) | yes                      |
| REGX-004 | Tax Statement Available  | MEDIUM   | SERVICE       | email, inapp            | –          | defer                                   | no                       |
| REGX-005 | Regulatory Policy Change | MEDIUM   | SERVICE       | email, inapp            | –          | defer                                   | no                       |

Quiet hours only defer intrusive channels (`sms`, `push`, `whatsapp`); email and
in-app are delivered immediately. Payload fields, types and constraints per
event are in the YAML and exposed at `GET /api/v1/taxonomy/events`.

## Validation guarantees (enforced at load time)

- Codes match `ABCD-123`, are unique and use their category prefix.
- Default, fallback and mandatory channels ⊆ permitted channels.
- Promotional events cannot have mandatory channels, bypass quiet hours, or be
  cap-exempt; only CRITICAL events may bypass quiet hours (no blanket override).
- Idempotency and cooldown key fields must be required payload fields.
- Payload schemas are strict (unknown fields rejected); money is decimal
  strings (no float arithmetic); URLs must be https; datetimes need an offset.

## Adding an event type

1. Append the definition to `config/event-taxonomy.yaml`.
2. Add `title/short/long` templates to `templates/en.yaml` (required) and other
   locales (optional — English is the fallback).
3. Add a sample payload to `src/modules/taxonomy/fixtures.ts`.
4. `npm test` (taxonomy, template-coverage and rendering tests run for every
   event automatically), then `npm run seed` (or `POST /api/v1/templates`) to
   load templates into the database.

No routing, compliance, scheduling or delivery code changes are needed.
