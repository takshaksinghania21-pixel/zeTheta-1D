/**
 * Writes docs/openapi.json and docs/api-specification.yaml (PDF §E2 path) from the
 * live route definitions (no infrastructure needed).
 */
import { writeFileSync } from 'node:fs';
import YAML from 'yaml';
import { buildOpenApi, createApi } from '../src/app';
import { loadConfig } from '../src/config/env';
import { Container } from '../src/container';

const placeholder = Buffer.alloc(32, 1).toString('base64');
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://unused/unused',
  REDIS_URL: 'redis://unused',
  RABBITMQ_URL: 'amqp://unused',
  JWT_SECRET: 'x'.repeat(32),
  DATA_ENCRYPTION_KEY: placeholder,
  DATA_HASH_KEY: placeholder,
  WEBHOOK_SIGNING_SECRET: 'x'.repeat(16),
});
const api = createApi(new Container(config));
const spec = buildOpenApi(api, 'http://localhost:3000') as {
  paths: Record<string, Record<string, unknown>>;
};
writeFileSync('docs/openapi.json', `${JSON.stringify(spec, null, 2)}\n`);
writeFileSync('docs/api-specification.yaml', YAML.stringify(spec, { lineWidth: 0 }));
const operations = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
console.log(
  `docs/openapi.json + docs/api-specification.yaml written: ${Object.keys(spec.paths).length} paths, ${operations} operations`,
);
