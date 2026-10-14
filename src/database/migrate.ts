/* Migration CLI: `migrate.ts latest | rollback | status` */
import 'dotenv/config';
import { envSchema } from '../config/env';
import { createDb } from './knex';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'latest';
  // Only the database settings are needed here, parsed exactly as the application does (incl. TLS).
  const env = envSchema
    .pick({ DATABASE_URL: true, DATABASE_SSL: true, DATABASE_SSL_CA_FILE: true })
    .parse(process.env);
  const db = createDb({
    url: env.DATABASE_URL,
    poolMax: 2,
    ssl: env.DATABASE_SSL,
    ...(env.DATABASE_SSL_CA_FILE ? { sslCaFile: env.DATABASE_SSL_CA_FILE } : {}),
    applicationName: 'zetheta-migrate',
  });
  try {
    if (cmd === 'latest') {
      const [batch, files] = (await db.migrate.latest()) as [number, string[]];
      process.stdout.write(
        `migrations: batch ${batch}, applied ${files.length}: ${files.join(', ') || 'none'}\n`,
      );
    } else if (cmd === 'rollback') {
      const [batch, files] = (await db.migrate.rollback()) as [number, string[]];
      process.stdout.write(`rolled back batch ${batch}: ${files.join(', ') || 'none'}\n`);
    } else if (cmd === 'status') {
      const [done, pending] = (await db.migrate.list()) as [{ name: string }[], { file: string }[]];
      process.stdout.write(`completed: ${done.length}, pending: ${pending.length}\n`);
    } else {
      throw new Error(`unknown command ${cmd}`);
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
