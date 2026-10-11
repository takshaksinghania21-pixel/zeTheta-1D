// Deterministic, non-secret configuration for tests. Integration/e2e suites
// read connection URLs from the environment (TEST_DATABASE_URL etc.) when set.
import { config } from 'dotenv';
config({ quiet: true });
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent';
process.env.TZ = 'UTC';
