# Contributing

## Workflow

1. Branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Keep changes small and covered by tests; update docs and the traceability
   matrix (`docs/TRACEABILITY.md`) when behaviour changes.
3. Use [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `test:`, `docs:`, `chore:`, `refactor:`, `perf:`, `ci:`).
4. Open a pull request; CI must be green (format, lint, typecheck, unit,
   integration + e2e with coverage thresholds, build, audit, secret scan,
   Docker build).

## Local checks before pushing

```bash
npm run format:check && npm run lint && npm run typecheck
```

```bash
npm run test:coverage
```

```bash
npm run secrets:scan
```

## Code conventions

- TypeScript strict mode (`noUncheckedIndexedAccess`, no `any`); ESLint
  `strictTypeChecked`. Cast Knex results to explicit row types.
- State changes **only** through `NotificationLifecycle.transition()`.
- Anything that must reach Kafka/RabbitMQ after a DB change goes through the
  outbox in the same transaction (`enqueueOutbox`).
- Policy outcomes are recorded as typed `PolicyDecision`s.
- Never log raw contact details, tokens or secrets; pass objects to the logger
  (they are sanitised) rather than interpolating strings.
- Inject time and randomness (`Clock`, `RandomSource`) for testability.
- New event types: configuration + templates only (see docs/TAXONOMY.md).

## Tests

- Unit tests: no infrastructure, deterministic clocks.
- Integration/e2e: real PostgreSQL (`zetheta_test`), Redis DB 6, Kafka and
  RabbitMQ with unique prefixes; always `--runInBand` (shared test database).
- Prefer asserting persisted business outcomes over mock call counts.
