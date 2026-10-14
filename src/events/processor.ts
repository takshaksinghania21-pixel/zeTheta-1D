import type { Knex } from 'knex';
import type { Clock } from '../utils/clock';
import { NonRetryableError, errorMessage } from '../utils/errors';
import type { Logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import type { NotificationPolicy } from '../config/policy';
import type { Channel } from '../utils/types';
import type { PolicyDecision } from '../compliance/decisions';
import type { PolicyDecisionRepository } from '../compliance/decision-repository';
import type { DeadLetterRepository } from '../delivery/dlq/repository';
import type { FrequencyCapper } from '../compliance/frequency-cap/frequency-capper';
import type { NotificationFactory } from '../notifications/engine/factory';
import type { NotificationLifecycle } from '../notifications/state-machine/lifecycle';
import type { NotificationRow } from '../database/models/notification';
import type { ChannelPlan, RoutingEngine } from '../notifications/routing/routing-engine';
import type { EventTaxonomy } from './models/taxonomy';
import type { RenderedContent, TemplateEngine } from '../templates/engine/engine';
import type { UserContextService } from '../notifications/engine/user-context';
import type { FinancialEventRow } from './ingestion';
import type { FeatureStore } from '../analytics/feature-store';
import type { KafkaEventMessage } from './validators/envelope';

const ACTOR = 'event-consumer';

export interface ProcessorDeps {
  db: Knex;
  taxonomy: EventTaxonomy;
  policy: NotificationPolicy;
  userContext: UserContextService;
  routing: RoutingEngine;
  templates: TemplateEngine;
  factory: NotificationFactory;
  lifecycle: NotificationLifecycle;
  decisions: PolicyDecisionRepository;
  dlq: DeadLetterRepository;
  capper: FrequencyCapper;
  /** Engagement history for routing priority 3; optional so routing works without it. */
  features?: FeatureStore;
  clock: Clock;
  logger: Logger;
}

export type ProcessResult = 'PROCESSED' | 'ALREADY_PROCESSED' | 'FAILED';

/**
 * Consumes one financial-event reference: enrich → comply → route → render →
 * persist. All notifications, state history, policy decisions, scheduled jobs and
 * outbox messages for the event are written in ONE transaction, then the Kafka
 * offset is committed (at-least-once + idempotent processing = effectively once).
 */
export class EventProcessor {
  constructor(private readonly d: ProcessorDeps) {}

  async process(msg: KafkaEventMessage): Promise<ProcessResult> {
    const event = (await this.d.db('financial_events').where({ id: msg.eventId }).first()) as
      | FinancialEventRow
      | undefined;
    if (!event) throw new NonRetryableError(`Unknown event ${msg.eventId}`, 'UNKNOWN_EVENT');
    if (event.status === 'PROCESSED' || event.status === 'FAILED') return 'ALREADY_PROCESSED';

    const def = this.d.taxonomy.get(event.event_type);
    const validation = this.d.taxonomy.validatePayload(event.event_type, event.payload);
    if (!def || !validation.ok) {
      await this.fail(
        event,
        'SCHEMA_INVALID',
        def
          ? 'Stored payload no longer matches the event schema'
          : `Event type ${event.event_type} is no longer registered`,
      );
      return 'FAILED';
    }
    const payload = validation.payload;
    const ctx = await this.d.userContext.load(event.user_id);
    // Engagement is an optimisation: if Redis is unavailable, route without it.
    const engagement = await this.d.features?.engagement(event.user_id).catch(() => undefined);
    const plan = await this.d.routing.route({
      eventId: event.id,
      def,
      cooldownSubject: this.d.taxonomy.cooldownSubject(def, payload),
      userId: event.user_id,
      userStatus: ctx.user.status,
      preferences: ctx.preferences,
      contacts: ctx.contacts,
      consents: ctx.consents,
      ...(engagement ? { engagement } : {}),
    });

    const requiredFields = Object.entries(def.fields)
      .filter(([, f]) => f.required)
      .map(([k]) => k);
    const rendered = new Map<Channel, RenderedContent | Error>();
    for (const p of plan.plans) {
      if (p.action === 'DND' || p.action === 'SUPPRESS') continue;
      try {
        rendered.set(
          p.channel,
          await this.d.templates.render({
            eventType: def.code,
            channel: p.channel,
            locale: ctx.preferences.locale,
            timezone: ctx.preferences.timezone,
            data: payload,
            user: { name: ctx.user.display_name },
            requiredFields,
            abSubject: event.user_id,
          }),
        );
      } catch (err) {
        metrics.templateFailures.inc({ event_type: def.code, channel: p.channel });
        rendered.set(p.channel, err instanceof Error ? err : new Error(errorMessage(err)));
      }
    }

    // PDF §A6.2: more than 8 notifications/day over a rolling 7 days → suggest a digest.
    if (plan.plans.some((p) => p.action === 'QUEUE' && p.channel !== 'inapp')) {
      const { dailyThreshold, windowSeconds } = this.d.policy.frequencyCaps.digestSuggestion;
      const n = await this.d.capper.recordNotified(event.user_id, event.id, this.d.clock.now());
      if (n > dailyThreshold * (windowSeconds / 86400)) {
        await this.d
          .db('digest_suggestions')
          .insert({
            user_id: event.user_id,
            notifications_in_window: n,
            suggested_at: this.d.clock.now(),
          })
          .onConflict('user_id')
          .merge({ notifications_in_window: n, suggested_at: this.d.clock.now() });
      }
    }

    const outcome = await this.d.db.transaction(async (trx) => {
      const locked = (await trx('financial_events')
        .where({ id: event.id })
        .forUpdate()
        .first('status')) as { status: string } | undefined;
      if (locked?.status === 'PROCESSED') return 'ALREADY_PROCESSED' as const;
      const byChannel = new Map<Channel, string>();
      for (const p of plan.plans) {
        const id = await this.persistPlan(
          trx,
          event,
          ctx.preferenceVersion,
          def.code,
          p,
          rendered.get(p.channel),
        );
        if (id) byChannel.set(p.channel, id);
      }
      await this.d.decisions.insert(
        trx,
        plan.decisions.map((dec: PolicyDecision) => ({
          decision: dec,
          eventId: event.id,
          notificationId: dec.channel ? (byChannel.get(dec.channel) ?? null) : null,
          userId: event.user_id,
          correlationId: event.correlation_id,
        })),
      );
      // Saga escalation (PDF §A1.2): no mandatory channel is reachable → manual call queue.
      const undeliverable = plan.decisions.find((d) => d.rule === 'MANDATORY_UNDELIVERABLE');
      if (undeliverable)
        await this.d.dlq.insert(trx, {
          source: 'EVENT',
          eventId: event.id,
          reasonCode: 'ESCALATE_MANUAL_CALL',
          reasonMessage: `${def.code}: no mandatory channel (${def.mandatoryChannels.join(', ')}) is reachable; contact the user manually`,
          attempts: 0,
          payload: { eventType: def.code, userId: event.user_id, priority: def.priority },
        });
      await trx('financial_events')
        .where({ id: event.id })
        .update({
          status: 'PROCESSED',
          processed_at: this.d.clock.now(),
          status_reason: plan.plans.length === 0 ? 'no deliverable channels' : null,
        });
      return 'PROCESSED' as const;
    });
    metrics.eventsProcessed.inc({ event_type: def.code, outcome: outcome.toLowerCase() });
    return outcome;
  }

  private async persistPlan(
    trx: Knex.Transaction,
    event: FinancialEventRow,
    preferenceVersion: number,
    eventType: string,
    p: ChannelPlan,
    content: RenderedContent | Error | undefined,
  ): Promise<string | null> {
    const def = this.d.taxonomy.get(eventType);
    if (!def) throw new Error(`event type ${eventType} disappeared from the taxonomy`);
    const ok = content instanceof Error ? null : (content ?? null);
    const row = await this.d.factory.create(
      trx,
      {
        dedupeKey: `evt:${event.id}:${p.channel}`,
        eventId: event.id,
        userId: event.user_id,
        eventType,
        category: def.category,
        channel: p.channel,
        priority: def.priority,
        regulatoryClass: def.regulatoryClass,
        locale: ok?.locale ?? 'en',
        content: ok,
        preferenceVersion,
        viaOverride: p.viaOverride,
        correlationId: event.correlation_id,
      },
      ACTOR,
    );
    if (!row) return null; // already created by an earlier (crashed) attempt
    const ctx = { actor: ACTOR, correlationId: event.correlation_id };
    let n: NotificationRow = await this.d.lifecycle.transition(trx, row, 'ENRICHED', ctx);
    if (p.action === 'DND') {
      await this.d.lifecycle.transition(trx, n, 'DND', { ...ctx, reason: p.reason ?? 'DND' });
      return row.id;
    }
    if (p.action === 'SUPPRESS') {
      await this.d.lifecycle.transition(trx, n, 'SUPPRESSED', {
        ...ctx,
        reason: p.reason ?? 'SUPPRESSED',
      });
      return row.id;
    }
    n = await this.d.lifecycle.transition(trx, n, 'ROUTED', {
      ...ctx,
      metadata: {
        action: p.action,
        viaOverride: p.viaOverride,
        fallbackFor: p.fallbackFor ?? null,
        quietBypassed: p.quietBypassed ?? false,
      },
    });
    if (content instanceof Error) {
      await this.d.lifecycle.transition(trx, n, 'FAILED', {
        ...ctx,
        reason: 'TEMPLATE_ERROR',
        patch: {
          last_error_code: 'TEMPLATE_ERROR',
          last_error_message: content.message.slice(0, 500),
        },
      });
      await this.d.dlq.insert(trx, {
        source: 'DELIVERY',
        notificationId: n.id,
        eventId: event.id,
        channel: p.channel,
        reasonCode: 'TEMPLATE_ERROR',
        reasonMessage: content.message,
        attempts: 0,
      });
      return row.id;
    }
    switch (p.action) {
      case 'QUEUE':
        await this.d.factory.queue(trx, n, {
          ...ctx,
          ...(p.quietBypassed ? { reason: 'QUIET_HOURS_BYPASS' } : {}),
        });
        if (p.quietBypassed) metrics.quietBypasses.inc();
        break;
      case 'CAP':
        await this.d.lifecycle.transition(trx, n, 'CAPPED', {
          ...ctx,
          reason: p.reason ?? 'FREQUENCY_CAP',
          metadata: { scheduledFor: p.releaseAt?.toISOString() ?? null },
          patch: { next_attempt_at: p.releaseAt ?? null },
        });
        if (p.releaseAt)
          await trx('scheduled_notifications')
            .insert({ kind: 'DIGEST', user_id: n.user_id, due_at: p.releaseAt })
            .onConflict()
            .ignore();
        metrics.capHits.inc({
          cap_type: (p.reason ?? 'FREQUENCY_CAP').replace('FREQUENCY_', '').toLowerCase(),
          event_type: n.event_type,
        });
        break;
      case 'DEFER':
        await this.d.lifecycle.transition(trx, n, 'QUIET', {
          ...ctx,
          reason: 'QUIET_HOURS_DEFER',
          patch: { next_attempt_at: p.releaseAt ?? null },
        });
        await trx('scheduled_notifications').insert({
          kind: 'QUIET_RELEASE',
          user_id: n.user_id,
          notification_id: n.id,
          notification_created_at: n.created_at,
          due_at: p.releaseAt,
        });
        metrics.quietDeferrals.inc();
        break;
      case 'DIGEST':
        await this.d.lifecycle.transition(trx, n, 'DIGESTED', {
          ...ctx,
          reason: 'DIGEST_BATCHED',
          patch: { next_attempt_at: p.releaseAt ?? null },
        });
        await trx('scheduled_notifications')
          .insert({ kind: 'DIGEST', user_id: n.user_id, due_at: p.releaseAt })
          .onConflict()
          .ignore();
        break;
      default:
        break;
    }
    return row.id;
  }

  /** Non-retryable failure: mark the event FAILED and park it in the DLQ. */
  async fail(
    event: Pick<FinancialEventRow, 'id' | 'event_type' | 'correlation_id'>,
    code: string,
    message: string,
  ): Promise<void> {
    await this.d.db.transaction(async (trx) => {
      await trx('financial_events')
        .where({ id: event.id })
        .update({
          status: 'FAILED',
          status_reason: `${code}: ${message}`.slice(0, 500),
          processed_at: this.d.clock.now(),
        });
      await this.d.dlq.insert(trx, {
        source: 'EVENT',
        eventId: event.id,
        reasonCode: code,
        reasonMessage: message,
        attempts: 1,
        payload: { eventId: event.id, eventType: event.event_type },
      });
    });
    metrics.eventsProcessed.inc({ event_type: event.event_type, outcome: 'failed' });
    this.d.logger.warn({ eventId: event.id, code }, 'event processing failed permanently');
  }
}
