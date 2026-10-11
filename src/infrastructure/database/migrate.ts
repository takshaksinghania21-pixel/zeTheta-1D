/* Migration CLI: `migrate.ts latest | rollback | status` */
import 'dotenv/config';
import { createDb } from './knex';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'latest';
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createDb({ url, poolMax: 2, applicationName: 'zetheta-migrate' });
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
