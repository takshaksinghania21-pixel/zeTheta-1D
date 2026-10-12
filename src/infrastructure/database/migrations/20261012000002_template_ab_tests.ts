import type { Knex } from 'knex';

/** Template A/B testing (PDF §A4.1, Day 4): a share of users gets an experiment version. */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE templates
      ADD COLUMN experiment_version integer,
      ADD COLUMN experiment_percent smallint NOT NULL DEFAULT 0
        CHECK (experiment_percent BETWEEN 0 AND 100);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE templates DROP COLUMN IF EXISTS experiment_percent,
      DROP COLUMN IF EXISTS experiment_version;
  `);
}
