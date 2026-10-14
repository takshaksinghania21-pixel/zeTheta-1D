import type { Knex } from 'knex';
import { AppError, NotFoundError } from '../../utils/errors';
import { canTransition } from '../state-machine/state-machine';
import type { NotificationLifecycle } from '../state-machine/lifecycle';
import type { NotificationRepository } from '../../database/models/notification-repository';
import type { NotificationRow } from '../../database/models/notification';

/** User-facing notification actions (in-app acknowledgements, reads, clicks). */
export class NotificationService {
  constructor(
    private readonly db: Knex,
    private readonly repo: NotificationRepository,
    private readonly lifecycle: NotificationLifecycle,
  ) {}

  private async owned(userId: string, id: string): Promise<NotificationRow> {
    const n = await this.repo.find(id);
    if (!n || n.user_id !== userId) throw new NotFoundError('Notification', id);
    return n;
  }

  /**
   * Client acknowledged receipt of an in-app notification. The socket emit
   * happens just before the dispatcher commits SENT, so a fast client can ack
   * while the row is still QUEUED/RETRYING; that ack must not be lost.
   */
  async acknowledge(userId: string, id: string, correlationId: string): Promise<NotificationRow> {
    const ackable = ['SENT', 'QUEUED', 'RETRYING'];
    const n = await this.owned(userId, id);
    if (n.channel !== 'inapp' || !ackable.includes(n.state)) return n;
    return this.db.transaction(async (trx) => {
      const locked = await this.repo.lock(trx, n.id, n.created_at);
      if (!locked || !ackable.includes(locked.state)) return locked ?? n;
      return this.lifecycle.transition(trx, locked, 'DELIVERED', {
        actor: `user:${userId}`,
        correlationId,
        reason: 'client-ack',
      });
    });
  }

  /** Marks an in-app notification as read (SENT/DELIVERED → READ). Idempotent. */
  async markRead(userId: string, id: string, correlationId: string): Promise<NotificationRow> {
    const n = await this.owned(userId, id);
    if (n.channel !== 'inapp')
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        409,
        'Only in-app notifications can be marked read by the user',
      );
    if (n.state === 'READ') return n;
    if (!canTransition(n.state, 'READ'))
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        409,
        `Notification in state ${n.state} cannot be marked read`,
      );
    return this.db.transaction(async (trx) => {
      const locked = await this.repo.lock(trx, n.id, n.created_at);
      if (!locked || locked.state === 'READ') return locked ?? n;
      return this.lifecycle.transition(trx, locked, 'READ', {
        actor: `user:${userId}`,
        correlationId,
      });
    });
  }

  /** Records a click (engagement metric; not a lifecycle state). First click only. */
  async recordClick(userId: string, id: string, correlationId: string): Promise<NotificationRow> {
    const n = await this.owned(userId, id);
    if (!['inapp', 'push'].includes(n.channel))
      throw new AppError(
        'VALIDATION_ERROR',
        400,
        'Click tracking is supported for in-app and push notifications',
      );
    if (n.clicked_at) return n;
    return this.db.transaction(async (trx) => {
      const [row] = (await trx('notifications')
        .where({ id: n.id, created_at: n.created_at })
        .whereNull('clicked_at')
        .update({ clicked_at: new Date() })
        .returning('*')) as NotificationRow[];
      if (row)
        await this.lifecycle.engagement(trx, row, { actor: `user:${userId}`, correlationId });
      return row ?? n;
    });
  }
}
