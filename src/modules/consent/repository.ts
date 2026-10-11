import type { Knex } from 'knex';
import type { Channel, ConsentPurpose } from '../../domain/types';
import type { ConsentState, ConsentStatus } from '../compliance/consent';

export interface ConsentRecordRow {
  id: string;
  user_id: string;
  channel: Channel;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  source: string;
  evidence: Record<string, unknown>;
  recorded_by: string;
  recorded_at: Date;
}

export class ConsentRepository {
  constructor(private readonly db: Knex) {}

  /** Appends a consent change (the ledger is never updated in place). */
  async record(
    input: {
      userId: string;
      channel: Channel;
      purpose: ConsentPurpose;
      status: ConsentStatus;
      source: string;
      evidence?: Record<string, unknown>;
      recordedBy: string;
    },
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<ConsentRecordRow> {
    const [row] = (await trx('consent_records')
      .insert({
        user_id: input.userId,
        channel: input.channel,
        purpose: input.purpose,
        status: input.status,
        source: input.source,
        evidence: JSON.stringify(input.evidence ?? {}),
        recorded_by: input.recordedBy,
      })
      .returning('*')) as ConsentRecordRow[];
    if (!row) throw new Error('consent insert failed');
    if (input.status === 'REVOKED') {
      await trx('opt_out_events').insert({
        user_id: input.userId,
        channel: input.channel,
        source: 'CONSENT',
      });
    }
    return row;
  }

  async history(userId: string): Promise<ConsentRecordRow[]> {
    return (await this.db('consent_records')
      .where({ user_id: userId })
      .orderBy('recorded_at', 'desc')
      .limit(500)) as ConsentRecordRow[];
  }

  async states(userId: string): Promise<ConsentState[]> {
    const rows = (await this.db('consent_records')
      .distinctOn(['channel', 'purpose'])
      .where({ user_id: userId })
      .orderBy([
        { column: 'channel' },
        { column: 'purpose' },
        { column: 'recorded_at', order: 'desc' },
      ])
      .select('*')) as ConsentRecordRow[];
    return rows.map((r) => ({
      channel: r.channel,
      purpose: r.purpose,
      status: r.status,
      recordedAt: new Date(r.recorded_at),
      source: r.source,
    }));
  }
}
