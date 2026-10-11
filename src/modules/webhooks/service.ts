import type { Knex } from 'knex';
import { sha256Hex } from '../../common/crypto';
import type { Logger } from '../../common/logger';
import { metrics } from '../../common/metrics';
import { canTransition, isForwardProgress } from '../../domain/state-machine';
import type { NotificationState } from '../../domain/types';
import type { NotificationLifecycle } from '../notifications/lifecycle';
import type { NotificationRow } from '../notifications/types';

export type ReceiptStatus = 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'BOUNCED';

export interface DeliveryReceipt {
  /** Provider-unique event id used for de-duplication. */
  providerEventId: string;
  providerMessageId: string;
  status: ReceiptStatus;
  occurredAt?: string;
  errorCode?: string;
}

export type ReceiptOutcome = 'APPLIED' | 'DUPLICATE' | 'UNKNOWN_MESSAGE' | 'STALE' | 'NO_CHANGE';

/**
 * Applies verified provider delivery receipts. Each receipt is recorded in
 * webhook_receipts with a unique (provider, provider_event_id) so replays and
 * duplicate callbacks are ignored; states only ever move forward.
 */
export class WebhookService {
  constructor(
    private readonly db: Knex,
    private readonly lifecycle: NotificationLifecycle,
    private readonly logger: Logger,
  ) {}

  async apply(
    provider: string,
    receipts: DeliveryReceipt[],
    rawBody: string,
  ): Promise<Record<ReceiptOutcome, number>> {
    const counts: Record<ReceiptOutcome, number> = {
      APPLIED: 0,
      DUPLICATE: 0,
      UNKNOWN_MESSAGE: 0,
      STALE: 0,
      NO_CHANGE: 0,
    };
    const payloadHash = sha256Hex(rawBody);
    for (const r of receipts) {
      const outcome = await this.db.transaction(async (trx) => {
        const inserted = (await trx('webhook_receipts')
          .insert({
            provider,
            provider_event_id: r.providerEventId.slice(0, 255),
            provider_message_id: r.providerMessageId.slice(0, 255),
            status: r.status,
            occurred_at:
              r.occurredAt && !Number.isNaN(Date.parse(r.occurredAt))
                ? new Date(r.occurredAt)
                : null,
            error_code: r.errorCode?.slice(0, 64) ?? null,
            payload_hash: payloadHash,
            outcome: 'PENDING',
          })
          .onConflict(['provider', 'provider_event_id'])
          .ignore()
          .returning('id')) as { id: string }[];
        const receiptId = inserted[0]?.id;
        if (!receiptId) return 'DUPLICATE' as const;
        const n = (await trx('notifications')
          .where({ provider_message_id: r.providerMessageId })
          .orderBy('created_at', 'desc')
          .forUpdate()
          .first()) as NotificationRow | undefined;
        let result: ReceiptOutcome;
        if (!n) result = 'UNKNOWN_MESSAGE';
        else result = await this.transition(trx, n, r, provider);
        await trx('webhook_receipts')
          .where({ id: receiptId })
          .update({ outcome: result, notification_id: n?.id ?? null });
        return result;
      });
      counts[outcome]++;
      metrics.webhooks.inc({ provider, outcome: outcome.toLowerCase() });
    }
    return counts;
  }

  /**
   * Replays receipts that arrived before the notification's provider message
   * id was committed (fast providers / clients). Called inside the dispatcher's
   * SENT transaction, so the replay is atomic with the send record.
   */
  async reconcile(trx: Knex.Transaction, n: NotificationRow): Promise<NotificationRow> {
    if (!n.provider_message_id) return n;
    const parked = (await trx('webhook_receipts')
      .where({ provider_message_id: n.provider_message_id, outcome: 'UNKNOWN_MESSAGE' })
      .orderBy('received_at')
      .forUpdate()) as {
      id: string;
      provider: string;
      provider_event_id: string;
      status: ReceiptStatus;
      occurred_at: Date | null;
      error_code: string | null;
    }[];
    let current = n;
    for (const p of parked) {
      const receipt: DeliveryReceipt = {
        providerEventId: p.provider_event_id,
        providerMessageId: n.provider_message_id,
        status: p.status,
        ...(p.occurred_at ? { occurredAt: new Date(p.occurred_at).toISOString() } : {}),
        ...(p.error_code ? { errorCode: p.error_code } : {}),
      };
      const outcome = await this.transition(trx, current, receipt, p.provider);
      await trx('webhook_receipts')
        .where({ id: p.id })
        .update({
          outcome: outcome === 'APPLIED' ? 'APPLIED_LATE' : outcome,
          notification_id: n.id,
        });
      current =
        ((await trx('notifications').where({ id: n.id, created_at: n.created_at }).first()) as
          | NotificationRow
          | undefined) ?? current;
    }
    return current;
  }

  private async transition(
    trx: Knex.Transaction,
    n: NotificationRow,
    r: DeliveryReceipt,
    provider: string,
  ): Promise<ReceiptOutcome> {
    const target: NotificationState = r.status;
    if (n.state === target) return 'NO_CHANGE';
    if (!isForwardProgress(n.state, target) || !canTransition(n.state, target)) {
      this.logger.debug(
        { notificationId: n.id, from: n.state, to: target },
        'ignoring stale/out-of-order receipt',
      );
      return 'STALE';
    }
    const at =
      r.occurredAt && !Number.isNaN(Date.parse(r.occurredAt)) ? new Date(r.occurredAt) : new Date();
    await this.lifecycle.transition(trx, n, target, {
      actor: `webhook:${provider}`,
      correlationId: n.correlation_id,
      reason: r.errorCode ?? null,
      metadata: { providerEventId: r.providerEventId },
      at,
      ...(r.errorCode ? { patch: { last_error_code: r.errorCode.slice(0, 64) } } : {}),
    });
    return 'APPLIED';
  }
}
