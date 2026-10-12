import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { NotificationPolicy } from '../../config/policy';
import type {
  Category,
  Channel,
  Locale,
  NotificationState,
  Priority,
  RegulatoryClass,
} from '../../domain/types';
import { enqueueOutbox } from '../../infrastructure/outbox/outbox';
import type { RabbitTopology } from '../../infrastructure/rabbitmq/rabbitmq';
import type { RenderedContent } from '../templates/engine';
import type { NotificationLifecycle, TransitionContext } from './lifecycle';
import type { DeliveryMessage, NotificationRow } from './types';

export interface NewNotification {
  dedupeKey: string;
  eventId: string | null;
  userId: string;
  eventType: string;
  category: Category | 'DIGEST';
  channel: Channel;
  priority: Priority;
  regulatoryClass: RegulatoryClass;
  locale: Locale;
  content: RenderedContent | null;
  preferenceVersion: number | null;
  viaOverride?: boolean;
  parentNotificationId?: string | null;
  isDigest?: boolean;
  correlationId: string;
  createdAt?: Date;
}

/** Creation + routing helpers shared by the event processor, fallbacks and digests. */
export class NotificationFactory {
  constructor(
    private readonly lifecycle: NotificationLifecycle,
    private readonly policy: NotificationPolicy,
    private readonly topology: RabbitTopology,
  ) {}

  /**
   * Inserts a notification and its CREATED history entry. Returns null when the
   * dedupe key already exists (duplicate processing of the same logical notification).
   */
  async create(
    trx: Knex.Transaction,
    spec: NewNotification,
    actor: string,
  ): Promise<NotificationRow | null> {
    const id = randomUUID();
    const createdAt = spec.createdAt ?? this.lifecycle.clock.now();
    const key = (await trx('notification_keys')
      .insert({
        dedupe_key: spec.dedupeKey,
        notification_id: id,
        notification_created_at: createdAt,
      })
      .onConflict('dedupe_key')
      .ignore()
      .returning('dedupe_key')) as { dedupe_key: string }[];
    if (key.length === 0) return null;
    const [row] = (await trx('notifications')
      .insert({
        id,
        created_at: createdAt,
        event_id: spec.eventId,
        user_id: spec.userId,
        event_type: spec.eventType,
        category: spec.category,
        channel: spec.channel,
        priority: spec.priority,
        regulatory_class: spec.regulatoryClass,
        state: 'CREATED',
        locale: spec.locale,
        template_version: spec.content?.templateVersion ?? null,
        content: spec.content ? JSON.stringify(spec.content) : null,
        preference_version: spec.preferenceVersion,
        via_override: spec.viaOverride ?? false,
        parent_notification_id: spec.parentNotificationId ?? null,
        is_digest: spec.isDigest ?? false,
        max_retries: this.policy.retryProfiles[spec.priority].maxRetries,
        correlation_id: spec.correlationId,
        updated_at: createdAt,
      })
      .returning('*')) as NotificationRow[];
    if (!row) throw new Error('notification insert failed');
    await this.lifecycle.created(trx, row, { actor, correlationId: spec.correlationId });
    return row;
  }

  /** Applies a sequence of transitions, returning the final row. */
  async advance(
    trx: Knex.Transaction,
    row: NotificationRow,
    path: NotificationState[],
    ctx: TransitionContext,
  ): Promise<NotificationRow> {
    let current = row;
    for (const [i, state] of path.entries()) {
      const last = i === path.length - 1;
      current = await this.lifecycle.transition(
        trx,
        current,
        state,
        last ? ctx : { actor: ctx.actor, correlationId: ctx.correlationId },
      );
    }
    return current;
  }

  /** Transition to QUEUED and enqueue the RabbitMQ delivery message (same transaction). */
  async queue(
    trx: Knex.Transaction,
    row: NotificationRow,
    ctx: TransitionContext,
  ): Promise<NotificationRow> {
    const queued = await this.lifecycle.transition(trx, row, 'QUEUED', ctx);
    await this.enqueueDelivery(trx, queued, queued.retry_count);
    return queued;
  }

  async enqueueDelivery(
    trx: Knex | Knex.Transaction,
    row: Pick<NotificationRow, 'id' | 'channel' | 'priority' | 'correlation_id'> & {
      created_at: Date | string;
    },
    retry: number,
  ): Promise<void> {
    const msg: DeliveryMessage = {
      notificationId: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      retry,
      correlationId: row.correlation_id,
    };
    await enqueueOutbox(trx, [
      {
        destination: 'RABBITMQ',
        exchange: this.topology.deliveryExchange,
        routingKey: row.channel,
        payload: msg,
        priority: this.policy.queuePriority[row.priority],
        messageId: `${row.id}:${retry}`,
        headers: { 'x-correlation-id': row.correlation_id },
      },
    ]);
  }
}
