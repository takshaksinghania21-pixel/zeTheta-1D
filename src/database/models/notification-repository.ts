import type { Knex } from 'knex';
import { NotFoundError } from '../../utils/errors';
import type { Channel, NotificationState } from '../../utils/types';
import type { NotificationRow } from './notification';

export interface ListFilter {
  userId?: string;
  state?: NotificationState;
  channel?: Channel;
  category?: string;
  eventId?: string;
  unreadOnly?: boolean;
  limit: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(JSON.stringify([new Date(row.created_at).toISOString(), row.id])).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      !Number.isNaN(Date.parse(v[0]))
    )
      return [v[0], v[1]];
  } catch {
    /* invalid cursor */
  }
  return null;
}

export class NotificationRepository {
  constructor(private readonly db: Knex) {}

  async find(
    id: string,
    createdAt?: Date | string,
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<NotificationRow | undefined> {
    const q = trx('notifications').where({ id });
    if (createdAt) q.andWhere({ created_at: new Date(createdAt) });
    return (await q.first()) as NotificationRow | undefined;
  }

  async require(
    id: string,
    createdAt?: Date | string,
    trx: Knex | Knex.Transaction = this.db,
  ): Promise<NotificationRow> {
    const n = await this.find(id, createdAt, trx);
    if (!n) throw new NotFoundError('Notification', id);
    return n;
  }

  /** Row lock for a state change inside a transaction. */
  async lock(
    trx: Knex.Transaction,
    id: string,
    createdAt: Date | string,
  ): Promise<NotificationRow | undefined> {
    return (await trx('notifications')
      .where({ id, created_at: new Date(createdAt) })
      .forUpdate()
      .first()) as NotificationRow | undefined;
  }

  async findByProviderMessageId(providerMessageId: string): Promise<NotificationRow | undefined> {
    return (await this.db('notifications')
      .where({ provider_message_id: providerMessageId })
      .orderBy('created_at', 'desc')
      .first()) as NotificationRow | undefined;
  }

  async list(filter: ListFilter): Promise<Page<NotificationRow>> {
    const q = this.db('notifications').select('*');
    if (filter.userId) q.where('user_id', filter.userId);
    if (filter.state) q.where('state', filter.state);
    if (filter.channel) q.where('channel', filter.channel);
    if (filter.category) q.where('category', filter.category);
    if (filter.eventId) q.where('event_id', filter.eventId);
    if (filter.unreadOnly)
      q.whereNull('read_at').where('channel', 'inapp').whereIn('state', ['SENT', 'DELIVERED']);
    if (filter.cursor) {
      const c = decodeCursor(filter.cursor);
      if (c) q.whereRaw('(created_at, id) < (?, ?)', [c[0], c[1]]);
    }
    const rows = (await q
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(filter.limit + 1)) as NotificationRow[];
    const items = rows.slice(0, filter.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > filter.limit && last ? encodeCursor(last) : null };
  }

  async attempts(notificationId: string): Promise<Record<string, unknown>[]> {
    return (await this.db('delivery_attempts')
      .where({ notification_id: notificationId })
      .orderBy('started_at')) as Record<string, unknown>[];
  }

  async history(notificationId: string): Promise<Record<string, unknown>[]> {
    return (await this.db('notification_state_history')
      .where({ notification_id: notificationId })
      .orderBy('seq')) as Record<string, unknown>[];
  }

  async byEvent(eventId: string): Promise<NotificationRow[]> {
    return (await this.db('notifications')
      .where({ event_id: eventId })
      .orderBy('created_at')) as NotificationRow[];
  }
}
