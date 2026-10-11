import type { Knex } from 'knex';
import type { DndRegistryEntry, DndRegistrySource, DndStatus } from './dnd';
import type { PolicyDecision } from './decisions';

export class PolicyDecisionRepository {
  constructor(private readonly db: Knex) {}

  async insert(
    trx: Knex | Knex.Transaction,
    rows: {
      decision: PolicyDecision;
      eventId: string | null;
      notificationId: string | null;
      userId: string;
      correlationId: string;
    }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await trx('policy_decisions').insert(
      rows.map((r) => ({
        event_id: r.eventId,
        notification_id: r.notificationId,
        user_id: r.userId,
        channel: r.decision.channel,
        rule: r.decision.rule,
        outcome: r.decision.outcome,
        explanation: r.decision.explanation,
        metadata: JSON.stringify(r.decision.metadata ?? {}),
        correlation_id: r.correlationId,
      })),
    );
  }

  async list(filter: {
    eventId?: string;
    notificationId?: string;
    userId?: string;
    rule?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]> {
    const q = this.db('policy_decisions').select('*');
    if (filter.eventId) q.where('event_id', filter.eventId);
    if (filter.notificationId) q.where('notification_id', filter.notificationId);
    if (filter.userId) q.where('user_id', filter.userId);
    if (filter.rule) q.where('rule', filter.rule);
    return (await q.orderBy('created_at', 'desc').limit(filter.limit)) as Record<string, unknown>[];
  }
}

/** DND registry source backed by authorised imports stored in PostgreSQL. */
export class PostgresDndSource implements DndRegistrySource {
  constructor(private readonly db: Knex) {}

  async find(phoneHash: string): Promise<DndRegistryEntry | null> {
    const row = (await this.db('dnd_registry_entries').where({ phone_hash: phoneHash }).first()) as
      | {
          status: DndStatus;
          blocked_categories: string[];
          registry_updated_at: Date;
          source: string;
        }
      | undefined;
    if (!row) return null;
    return {
      status: row.status,
      blockedCategories: row.blocked_categories,
      registryUpdatedAt: new Date(row.registry_updated_at),
      source: row.source,
    };
  }

  async latestSnapshotAt(): Promise<Date | null> {
    const row = (await this.db('dnd_registry_imports')
      .max('registry_snapshot_at as at')
      .first()) as { at: Date | null } | undefined;
    return row?.at ? new Date(row.at) : null;
  }

  async import(input: {
    source: string;
    snapshotAt: Date;
    importedBy: string;
    entries: { phoneHash: string; status: DndStatus; blockedCategories: string[] }[];
  }): Promise<{ importId: string; count: number }> {
    return this.db.transaction(async (trx) => {
      const [imp] = (await trx('dnd_registry_imports')
        .insert({
          source: input.source,
          registry_snapshot_at: input.snapshotAt,
          record_count: input.entries.length,
          imported_by: input.importedBy,
        })
        .returning('id')) as { id: string }[];
      if (!imp) throw new Error('import insert failed');
      for (let i = 0; i < input.entries.length; i += 500) {
        const chunk = input.entries.slice(i, i + 500);
        await trx('dnd_registry_entries')
          .insert(
            chunk.map((e) => ({
              phone_hash: e.phoneHash,
              status: e.status,
              blocked_categories: e.blockedCategories,
              source: input.source,
              registry_updated_at: input.snapshotAt,
              import_id: imp.id,
            })),
          )
          .onConflict('phone_hash')
          .merge([
            'status',
            'blocked_categories',
            'source',
            'registry_updated_at',
            'import_id',
            'updated_at',
          ]);
      }
      return { importId: imp.id, count: input.entries.length };
    });
  }
}
