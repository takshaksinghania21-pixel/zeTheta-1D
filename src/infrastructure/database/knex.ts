import { readdirSync } from 'node:fs';
import path from 'node:path';
import knex, { type Knex } from 'knex';
import pg from 'pg';

// BIGINT (int8) values are returned as JS numbers where safe; counts in this
// system stay far below 2^53. NUMERIC stays a string to preserve precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export type Db = Knex;

export function createDb(options: {
  url: string;
  poolMax: number;
  ssl?: boolean;
  applicationName?: string;
}): Knex {
  return knex({
    client: 'pg',
    connection: {
      connectionString: options.url,
      ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
      application_name: options.applicationName ?? 'zetheta-notify',
    },
    pool: { min: 0, max: options.poolMax, idleTimeoutMillis: 30000 },
    acquireConnectionTimeout: 10000,
    migrations: {
      tableName: 'knex_migrations',
      migrationSource: new ExtensionAgnosticMigrationSource(path.resolve(__dirname, 'migrations')),
    },
  });
}

/**
 * Migration names are recorded WITHOUT file extension, so a database migrated
 * from TypeScript sources (tsx, tests) and from the compiled build (dist/*.js)
 * see the same history.
 */
export class ExtensionAgnosticMigrationSource implements Knex.MigrationSource<string> {
  constructor(private readonly dir: string) {}

  getMigrations(): Promise<string[]> {
    const files = readdirSync(this.dir).filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts'));
    return Promise.resolve([...new Set(files.map((f) => f.replace(/\.(ts|js)$/, '')))].sort());
  }

  getMigrationName(migration: string): string {
    return migration;
  }

  async getMigration(migration: string): Promise<Knex.Migration> {
    const ext = path.extname(__filename);
    return (await import(path.join(this.dir, `${migration}${ext}`))) as Knex.Migration;
  }
}
