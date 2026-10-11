import type { Knex } from 'knex';
import { AppError, ConflictError } from '../../common/errors';
import type { AuditLog } from '../audit/audit';
import type { NotificationFactory } from '../notifications/factory';
import type { NotificationLifecycle } from '../notifications/lifecycle';
import type { NotificationRepository } from '../notifications/repository';
import type { DeadLetterRepository, DeadLetterRow } from './repository';
import { kafkaEventSchema } from '../events/ingestion';
import { enqueueOutbox } from '../../infrastructure/outbox/outbox';

export interface Actor {
  id: string;
  role: string;
}

/** Authorised operator actions on dead-letter entries (always audited). */
export class DeadLetterService {
  constructor(
    private readonly db: Knex,
    private readonly repo: DeadLetterRepository,
    private readonly notifications: NotificationRepository,
    private readonly lifecycle: NotificationLifecycle,
    private readonly factory: NotificationFactory,
    private readonly audit: AuditLog,
    private readonly eventsTopic: string,
  ) {}

  /**
   * Manual retry: the notification goes DLQ → QUEUED with a fresh retry budget
   * (retry_count reset) and is re-enqueued; EVENT entries are re-published.
   */
  async retry(id: string, actor: Actor, note?: string): Promise<DeadLetterRow> {
    return this.db.transaction(async (trx) => {
      const entry = await this.lockOpen(trx, id);
      if (entry.source === 'DELIVERY' && entry.notification_id) {
        const n = await this.notifications.find(entry.notification_id, undefined, trx);
        if (!n) throw new ConflictError('Notification for this entry no longer exists');
        if (n.state !== 'DLQ')
          throw new ConflictError(
            `Notification is ${n.state}; only DLQ notifications can be retried`,
          );
        const queued = await this.lifecycle.transition(trx, n, 'QUEUED', {
          actor: `operator:${actor.id}`,
          correlationId: n.correlation_id,
          reason: 'MANUAL_RETRY',
          metadata: { dlqId: id, note: note ?? null },
          // Fresh retry budget without rewinding retry_count, so any stale
          // in-flight retry messages remain recognisably stale.
          patch: {
            retry_budget_start: n.retry_count,
            next_attempt_at: null,
            last_error_code: null,
            last_error_message: null,
          },
        });
        await this.factory.enqueueDelivery(trx, queued, queued.retry_count);
      } else if (entry.source === 'EVENT' && entry.event_id) {
        const event = (await trx('financial_events').where({ id: entry.event_id }).first()) as
          | {
              id: string;
              event_type: string;
              user_id: string;
              occurred_at: Date;
              correlation_id: string;
            }
          | undefined;
        if (!event) throw new ConflictError('Event for this entry no longer exists');
        await trx('financial_events')
          .where({ id: event.id })
          .update({ status: 'RECEIVED', status_reason: null, processed_at: null });
        const message = kafkaEventSchema.parse({
          eventId: event.id,
          eventType: event.event_type,
          userId: event.user_id,
          occurredAt: new Date(event.occurred_at).toISOString(),
          correlationId: event.correlation_id,
          schemaVersion: 1,
        });
        await enqueueOutbox(trx, [
          {
            destination: 'KAFKA',
            topic: this.eventsTopic,
            key: event.user_id,
            payload: message,
            headers: { 'x-correlation-id': event.correlation_id },
          },
        ]);
      } else {
        throw new AppError(
          'CONFLICT',
          409,
          'Poison entries cannot be retried automatically; resolve or discard them',
        );
      }
      const [updated] = (await trx('dead_letter_entries')
        .where({ id })
        .update({
          status: 'RETRIED',
          resolved_by: actor.id,
          resolved_at: trx.fn.now(),
          resolution_note: note ?? null,
          updated_at: trx.fn.now(),
        })
        .returning('*')) as DeadLetterRow[];
      await this.audit.record(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: 'DLQ_RETRY',
          targetType: 'dead_letter_entry',
          targetId: id,
          metadata: { notificationId: entry.notification_id, eventId: entry.event_id, note },
        },
        trx,
      );
      if (!updated) throw new Error('dead-letter update failed');
      return updated;
    });
  }

  /** RESOLVED: handled out-of-band. DISCARDED: abandoned (notification → FAILED). */
  async resolve(
    id: string,
    resolution: 'RESOLVED' | 'DISCARDED',
    actor: Actor,
    note: string,
  ): Promise<DeadLetterRow> {
    return this.db.transaction(async (trx) => {
      const entry = await this.lockOpen(trx, id);
      if (resolution === 'DISCARDED' && entry.notification_id) {
        const n = await this.notifications.find(entry.notification_id, undefined, trx);
        if (n?.state === 'DLQ') {
          await this.lifecycle.transition(trx, n, 'FAILED', {
            actor: `operator:${actor.id}`,
            correlationId: n.correlation_id,
            reason: 'DISCARDED_BY_OPERATOR',
            metadata: { dlqId: id, note },
          });
        }
      }
      const [updated] = (await trx('dead_letter_entries')
        .where({ id })
        .update({
          status: resolution,
          resolved_by: actor.id,
          resolved_at: trx.fn.now(),
          resolution_note: note,
          updated_at: trx.fn.now(),
        })
        .returning('*')) as DeadLetterRow[];
      await this.audit.record(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: `DLQ_${resolution}`,
          targetType: 'dead_letter_entry',
          targetId: id,
          metadata: { note },
        },
        trx,
      );
      if (!updated) throw new Error('dead-letter update failed');
      return updated;
    });
  }

  private async lockOpen(trx: Knex.Transaction, id: string): Promise<DeadLetterRow> {
    await this.repo.require(id, trx);
    const entry = (await trx('dead_letter_entries')
      .where({ id })
      .forUpdate()
      .first()) as DeadLetterRow;
    if (entry.status !== 'OPEN')
      throw new ConflictError(`Dead-letter entry is already ${entry.status}`);
    return entry;
  }
}
