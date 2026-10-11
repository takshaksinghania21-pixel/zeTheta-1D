import type { Knex } from 'knex';
import { currentContext } from '../../common/context';
import { sanitizeForLog } from '../../common/pii';

export interface AuditEntry {
  actorId: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ipHash?: string | null;
}

/** Append-only audit trail for privileged operations and policy bypasses. */
export class AuditLog {
  constructor(private readonly db: Knex) {}

  async record(entry: AuditEntry, trx: Knex | Knex.Transaction = this.db): Promise<void> {
    await trx('audit_logs').insert({
      actor_id: entry.actorId,
      actor_role: entry.actorRole,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      metadata: JSON.stringify(sanitizeForLog(entry.metadata ?? {})),
      correlation_id: currentContext()?.correlationId ?? null,
      ip_hash: entry.ipHash ?? null,
    });
  }

  async list(filter: {
    targetType?: string;
    targetId?: string;
    action?: string;
    limit: number;
  }): Promise<Record<string, unknown>[]> {
    const q = this.db('audit_logs').select('*');
    if (filter.targetType) q.where('target_type', filter.targetType);
    if (filter.targetId) q.where('target_id', filter.targetId);
    if (filter.action) q.where('action', filter.action);
    return (await q.orderBy('created_at', 'desc').limit(filter.limit)) as Record<string, unknown>[];
  }
}
