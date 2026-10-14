import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { systemClock, type Clock } from '../../utils/clock';
import { assertTransition } from './state-machine';
import type { NotificationState } from '../../utils/types';
import { ConflictError } from '../../utils/errors';
import { metrics } from '../../utils/metrics';
import { enqueueOutbox } from '../../infrastructure/outbox/outbox';
import type { LifecycleEvent, NotificationRow } from '../../database/models/notification';

export interface TransitionContext {
  actor: string;
  correlationId: string;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Additional column updates applied atomically with the state change. */
  patch?: Partial<Record<keyof NotificationRow, unknown>>;
  at?: Date;
}

const TIMESTAMP_COLUMNS: Partial<Record<NotificationState, keyof NotificationRow>> = {
  QUEUED: 'queued_at',
  SENT: 'sent_at',
  DELIVERED: 'delivered_at',
  READ: 'read_at',
  FAILED: 'failed_at',
  BOUNCED: 'failed_at',
  DLQ: 'failed_at',
};

/**
 * The single place notification state changes. Each transition:
 *  1. validates the move against the state machine,
 *  2. updates the row with optimistic concurrency (WHERE state = from),
 *  3. appends notification_state_history,
 *  4. enqueues a lifecycle event in the outbox (same transaction).
 */
export class NotificationLifecycle {
  constructor(
    private readonly lifecycleTopic: string,
    readonly clock: Clock = systemClock,
  ) {}

  async transition(
    trx: Knex.Transaction,
    n: NotificationRow,
    to: NotificationState,
    ctx: TransitionContext,
  ): Promise<NotificationRow> {
    assertTransition(n.state, to);
    const at = ctx.at ?? this.clock.now();
    const patch: Record<string, unknown> = { ...(ctx.patch ?? {}), state: to, updated_at: at };
    const tsCol = TIMESTAMP_COLUMNS[to];
    if (tsCol && patch[tsCol] === undefined) patch[tsCol] = at;
    if (patch.content !== undefined && patch.content !== null)
      patch.content = JSON.stringify(patch.content);
    const updated = (await trx('notifications')
      .where({ id: n.id, created_at: n.created_at, state: n.state })
      .update(patch)
      .returning('*')) as NotificationRow[];
    const row = updated[0];
    if (!row)
      throw new ConflictError(`Notification ${n.id} changed concurrently (expected ${n.state})`);
    await this.record(trx, row, n.state, to, ctx, at);
    return row;
  }

  /** Records the initial CREATED history entry for a freshly inserted row. */
  async created(
    trx: Knex.Transaction,
    row: NotificationRow,
    ctx: TransitionContext,
  ): Promise<void> {
    await this.record(trx, row, null, 'CREATED', ctx, row.created_at);
  }

  /** Engagement events (clicks) that are not state transitions. */
  async engagement(
    trx: Knex.Transaction,
    row: NotificationRow,
    ctx: TransitionContext,
  ): Promise<void> {
    const at = ctx.at ?? this.clock.now();
    await enqueueOutbox(trx, [
      {
        destination: 'KAFKA',
        topic: this.lifecycleTopic,
        key: row.id,
        payload: this.event(row, randomUUID(), row.state, 'CLICKED', at, ctx, 'ENGAGEMENT'),
        headers: { 'x-correlation-id': ctx.correlationId },
      },
    ]);
  }

  private async record(
    trx: Knex.Transaction,
    row: NotificationRow,
    from: NotificationState | null,
    to: NotificationState,
    ctx: TransitionContext,
    at: Date,
  ): Promise<void> {
    const historyId = randomUUID();
    await trx('notification_state_history').insert({
      id: historyId,
      notification_id: row.id,
      from_state: from,
      to_state: to,
      actor: ctx.actor,
      correlation_id: ctx.correlationId,
      reason: ctx.reason ?? null,
      metadata: JSON.stringify(ctx.metadata ?? {}),
      created_at: at,
    });
    await enqueueOutbox(trx, [
      {
        destination: 'KAFKA',
        topic: this.lifecycleTopic,
        key: row.id,
        payload: this.event(row, historyId, from, to, at, ctx, 'TRANSITION'),
        headers: { 'x-correlation-id': ctx.correlationId },
      },
    ]);
    metrics.transitions.inc({ to_state: to, channel: row.channel });
    if (to === 'DELIVERED')
      metrics.deliveryLatency.observe(
        { channel: row.channel, priority: row.priority },
        (at.getTime() - new Date(row.created_at).getTime()) / 1000,
      );
  }

  private event(
    row: NotificationRow,
    id: string,
    from: NotificationState | null,
    to: LifecycleEvent['to'],
    at: Date,
    ctx: TransitionContext,
    kind: LifecycleEvent['kind'],
  ): LifecycleEvent {
    return {
      kind,
      transitionId: id,
      notificationId: row.id,
      eventId: row.event_id,
      userId: row.user_id,
      eventType: row.event_type,
      category: row.category,
      channel: row.channel,
      priority: row.priority,
      from,
      to,
      at: at.toISOString(),
      provider: row.provider,
      costMicros: to === 'SENT' ? row.cost_micros : 0,
      sinceCreatedMs: Math.max(0, at.getTime() - new Date(row.created_at).getTime()),
      reason: ctx.reason ?? null,
      correlationId: ctx.correlationId,
    };
  }
}
