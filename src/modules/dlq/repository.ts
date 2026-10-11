import type { Knex } from 'knex';
import { NotFoundError } from '../../common/errors';
import { metrics } from '../../common/metrics';

export interface DeadLetterRow {
  id: string;
  source: 'DELIVERY' | 'EVENT' | 'POISON';
  notification_id: string | null;
  event_id: string | null;
  channel: string | null;
  reason_code: string;
  reason_message: string;
  attempts: number;
  retry_history: unknown[];
  payload: Record<string, unknown>;
  status: 'OPEN' | 'RETRIED' | 'RESOLVED' | 'DISCARDED';
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
}

export class DeadLetterRepository {
  constructor(private readonly db: Knex) {}

  /** Inserts an OPEN entry; an existing OPEN entry for the same notification is reused. */
  async insert(
    trx: Knex | Knex.Transaction,
    entry: {
      source: DeadLetterRow['source'];
      notificationId?: string | null;
      eventId?: string | null;
      channel?: string | null;
      reasonCode: string;
      reasonMessage: string;
      attempts: number;
      retryHistory?: unknown[];
      payload?: Record<string, unknown>;
    },
  ): Promise<string> {
    const rows = (await trx('dead_letter_entries')
      .insert({
        source: entry.source,
        notification_id: entry.notificationId ?? null,
        event_id: entry.eventId ?? null,
        channel: entry.channel ?? null,
        reason_code: entry.reasonCode,
        reason_message: entry.reasonMessage.slice(0, 1000),
        attempts: entry.attempts,
        retry_history: JSON.stringify(entry.retryHistory ?? []),
        payload: JSON.stringify(entry.payload ?? {}),
      })
      .onConflict()
      .ignore()
      .returning('id')) as { id: string }[];
    metrics.dlqEntries.inc({ source: entry.source, reason: entry.reasonCode });
    if (rows[0]) return rows[0].id;
    const q = trx('dead_letter_entries').where({ status: 'OPEN' });
    if (entry.notificationId) q.where('notification_id', entry.notificationId);
    else q.where('event_id', entry.eventId ?? null);
    const existing = (await q.first('id')) as { id: string } | undefined;
    if (!existing) throw new Error('DLQ insert conflict without existing entry');
    return existing.id;
  }

  async list(filter: {
    status?: string;
    source?: string;
    channel?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: DeadLetterRow[]; total: number }> {
    const base = this.db('dead_letter_entries');
    if (filter.status) base.where('status', filter.status);
    if (filter.source) base.where('source', filter.source);
    if (filter.channel) base.where('channel', filter.channel);
    const [{ count } = { count: '0' }] = (await base.clone().count('* as count')) as {
      count: string;
    }[];
    const items = (await base
      .clone()
      .orderBy('created_at', 'desc')
      .limit(filter.limit)
      .offset(filter.offset)) as DeadLetterRow[];
    return { items, total: Number(count) };
  }

  async require(id: string, trx: Knex | Knex.Transaction = this.db): Promise<DeadLetterRow> {
    const row = (await trx('dead_letter_entries').where({ id }).first()) as
      | DeadLetterRow
      | undefined;
    if (!row) throw new NotFoundError('Dead-letter entry', id);
    return row;
  }

  async openCount(): Promise<number> {
    const [{ count } = { count: '0' }] = (await this.db('dead_letter_entries')
      .where({ status: 'OPEN' })
      .count('* as count')) as { count: string }[];
    const n = Number(count);
    metrics.dlqOpen.set(n);
    return n;
  }
}
