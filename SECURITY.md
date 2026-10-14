# Security

This document lists the security and privacy controls that are **implemented and
tested**, the compliance assumptions that need independent legal verification,
the scan results, and the known gaps. Report vulnerabilities privately to the
repository owner; do not open public issues for security problems.

## 1. Controls implemented

| Control                    | Implementation                                                                                                                                                                                                                                                                                   | Verified by                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication             | JWT (HS256) access tokens, 15 min TTL, issuer/audience/`typ` checked, `alg=none` rejected                                                                                                                                                                                                        | `tests/integration/api.test.ts` (authentication)                                                                                          |
| Refresh tokens             | Opaque, stored as SHA-256 hashes, rotated on every use; reuse of a rotated token revokes the whole family; logout revokes the family                                                                                                                                                             | api.test.ts                                                                                                                               |
| Passwords / client secrets | scrypt (N=16384, r=8, p=1, 16-byte salt), constant-time comparison, dummy verification for unknown users                                                                                                                                                                                         | `tests/unit/security-config.test.ts`                                                                                                      |
| Authorisation              | RBAC matrix `ADMIN`, `OPERATOR`, `SERVICE`, `USER` (`src/api/middleware/permissions.ts`); end users restricted to their own resources; existence of others' notifications not leaked (404)                                                                                                       | unit + api tests (edge 13)                                                                                                                |
| Input validation           | Zod strict objects (unknown fields → 400), taxonomy-compiled payload schemas (422), https-only URLs, E.164 phones, size limits (1 MB JSON, 256 KB webhooks, batch ≤ 500)                                                                                                                         | api + taxonomy tests                                                                                                                      |
| SQL injection              | Parameterised Knex queries / bindings only; no string-built SQL with user input                                                                                                                                                                                                                  | code review                                                                                                                               |
| Template injection / XSS   | Sandboxed Handlebars: known helpers only (`knownHelpersOnly`), `log`/`lookup` removed, AST validation rejects partials, decorators, triple-stash, parent-scope access and undeclared variables; channel text is plain text; the email layout HTML-escapes everything; subjects stripped of CR/LF | `tests/unit/templates.test.ts`                                                                                                            |
| Webhook authenticity       | HMAC-SHA256 with timestamp tolerance (replay window), Twilio HMAC-SHA1, Meta `X-Hub-Signature-256`, MSG91 shared secret; constant-time compares; mandatory in production (forced)                                                                                                                | api + unit tests (edge 23)                                                                                                                |
| Webhook replay/duplicates  | Unique `(provider, provider_event_id)`; forward-only state changes                                                                                                                                                                                                                               | delivery + api tests (edge 7)                                                                                                             |
| Rate limiting              | Redis sliding window: 100/min per IP (public) and per principal, 1000/min webhooks, 10/min preference updates, auth endpoints 20/min; `RateLimit-*` and `Retry-After` headers                                                                                                                    | api + redis tests                                                                                                                         |
| CORS                       | Explicit allow-list; `*` rejected in production config                                                                                                                                                                                                                                           | api test                                                                                                                                  |
| Security headers           | Helmet (CSP `default-src 'self'`, `frame-ancestors 'none'`, nosniff, HSTS…); `x-powered-by` disabled                                                                                                                                                                                             | api test                                                                                                                                  |
| Encryption at rest         | Contact values (phone, email, push token) AES-256-GCM with key id (rotation supported); HMAC blind index for lookups; masked copy for display                                                                                                                                                    | persistence + unit tests                                                                                                                  |
| PII in logs                | Structured logger sanitises every object: secrets redacted, contact values masked, phone/email patterns scrubbed from free text; ids preserved                                                                                                                                                   | unit test                                                                                                                                 |
| PII in transport           | Kafka carries event references only; DND phone numbers hashed on import; DND lookups use POST (no PII in URLs)                                                                                                                                                                                   | code + api test                                                                                                                           |
| Data retention             | Rendered content, event payloads and error texts older than `RETENTION_DAYS` (90) scrubbed; ids/states/timestamps/costs kept                                                                                                                                                                     | api test (edge 20)                                                                                                                        |
| Anonymisation              | Admin-only erasure: contacts deleted, names/refs nulled, content/payloads scrubbed, sessions disabled, pending jobs cancelled, audited                                                                                                                                                           | api test (edge 20)                                                                                                                        |
| Audit logging              | `audit_logs` for privileged actions (DLQ retry/resolve/discard, template changes, provider changes, simulations, DND imports, consent, anonymisation, retention, user-token minting)                                                                                                             | api + delivery tests                                                                                                                      |
| Secrets handling           | Config validated at startup; production refuses placeholders, mock providers, `*` CORS, equal encryption/hash keys; real providers without credentials abort startup; `.env` git-ignored; provider credentials never logged or stored in DB                                                      | unit tests + `npm run secrets:scan`                                                                                                       |
| Containers                 | Multi-stage `node:20.19.6-alpine` image, npm/yarn removed from the runtime stage, `USER node` (non-root), tini, read-only root FS, `no-new-privileges`, `cap_drop: ALL` in compose; image < 200 MB checked in CI                                                                                 | Docker run: uid 1000, 183 MB, limits/read-only/cap_drop verified with `docker inspect` (CI job not run)                                   |
| Data in transit (database) | PostgreSQL TLS with certificate verification (`DATABASE_SSL=true`, `DATABASE_SSL_CA_FILE`, `rejectUnauthorized: true`); Compose starts PostgreSQL with `ssl=on` using `scripts/dev-certs.sh` certificates                                                                                        | Compose PostgreSQL: TLSv1.3 with trusted CA; plaintext (`hostnossl … reject`), untrusted CA and wrong host rejected; all app sessions TLS |
| Redis hardening            | Compose disables `FLUSHALL`, `FLUSHDB` and `KEYS` (`rename-command … ''`), `noeviction`, password required                                                                                                                                                                                       | Compose: `NOAUTH` without password; `COMMAND INFO` empty for the three commands                                                           |
| Compliance at dispatch     | DND, consent and preferences are re-checked when a notification is sent (not only when routed), **including digests**; each check is stored in `policy_decisions` with stage and timestamp                                                                                                       | delivery + scheduler tests                                                                                                                |

## 2. Compliance assumptions requiring independent verification

The assignment's compliance descriptions are implemented as **project
requirements**; they are not legal advice. Before production use, compliance and
legal must confirm (all values are configurable in YAML):

1. **Event classification** (`config/event-taxonomy.yaml`): the PDF's binary
   TRANSACTIONAL / PROMOTIONAL split is enforced by the loader. `RISK-005`,
   `SIPX-004`, `SIPX-005`, `MKTX-003`, `MKTX-004`, `MKTX-005` are PROMOTIONAL;
   everything else is TRANSACTIONAL. Digests are PROMOTIONAL when any folded
   notification is.
2. **Mandatory channels** (PDF §A2 / Appendix A): `TXNX-001/002`, `RISK-002/003`
   on SMS + push + email; `RISK-001` and `MKTX-002` on SMS + push; `REGX-001` on
   SMS + email; `REGX-003` on email. Overrides bypass user preferences but **not**
   consent revocation, DND for promotional traffic, or WhatsApp opt-in.
3. **DND applicability**: DND checks apply to PROMOTIONAL SMS only, at routing and
   again at dispatch; the category code `BANKING_INSURANCE_FINANCIAL` is a
   placeholder for the operator's real registry category codes. Stale/unavailable
   registry data fails **closed** for promotional traffic and open for
   transactional traffic.
4. **Implied consent** for transactional/service messages on SMS/email/push
   (explicit revocations are honoured); explicit opt-in for promotional messages
   and for **all** WhatsApp messages.
5. **DLT (India)**: SMS content must match DLT-registered templates; the MSG91
   adapter assumes a flow with a `##message##` variable.
6. **WhatsApp**: business-initiated messages outside the 24 h window require
   approved templates; the adapter sends text bodies (works for the Meta test
   number / in-window messages only).
7. **Retention (90 days)** and anonymisation scope (consent ledger and delivery
   metadata retained as compliance evidence) must match the applicable data
   protection regime.
8. **Translations** of templates (hi, mr, ta, te) are machine-assisted and must
   be reviewed by native speakers.

No public registry is scraped; DND data enters only via the authorised import
endpoint (synthetic fixtures in this repository).

## 3. Scan results (run on 2026-10-11; secret scan re-run 2026-10-12)

| Scan                               | Command                                   | Result                                                   |
| ---------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Dependency audit (production deps) | `npm audit --omit=dev --audit-level=high` | see `docs/TESTING.md` §5 for the recorded output         |
| Repository secret scan             | `npm run secrets:scan`                    | passes after fixing two findings (see below)             |
| gitleaks (full history)            | CI job `secrets`                          | **not run locally** (gitleaks not installed); runs in CI |
| Snyk                               | CI job `snyk`                             | optional; runs only when `SNYK_TOKEN` is configured      |

Findings fixed during development: the k6 summary export embedded the service
access token in `setup_data` (now stripped before writing reports), and the
local-infra script had a default broker password fallback (now required from
the environment).

## 4. Known gaps

- No MFA/SSO for human principals (password grant only); intended to sit behind
  the platform identity provider.
- JWT signing uses a shared HS256 secret; asymmetric keys + JWKS rotation are
  recommended for multi-service deployments.
- Field-encryption keys come from environment variables; production should use
  a KMS/secret manager and envelope encryption.
- Email open/click tracking is intentionally not implemented.
- Images were built and run locally (Docker Desktop, arm64) but not
  vulnerability-scanned (no Trivy/Snyk run), and CI has not run.
- Kafka uses PLAINTEXT between containers in Compose (internal network only, the
  external listener binds to 127.0.0.1). Production needs TLS + SASL
  (`KAFKA_SSL`, `KAFKA_SASL_*` are supported by the client).
- If Redis is unavailable, routing fails closed (events are retried, nothing is
  sent unchecked); this trades availability for compliance.
