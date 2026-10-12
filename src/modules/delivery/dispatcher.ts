import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import type { Redis } from 'ioredis';
import type { Clock, RandomSource } from '../../common/clock';
import { errorMessage } from '../../common/errors';
import type { Logger } from '../../common/logger';
import { metrics } from '../../common/metrics';
import { scrubString } from '../../common/pii';
import type { RateLimiter } from '../../common/rate-limiter';
import type { NotificationPolicy } from '../../config/policy';
import { enqueueOutbox } from '../../infrastructure/outbox/outbox';
import type { RabbitTopology } from '../../infrastructure/rabbitmq/rabbitmq';
import { evaluateConsent, latestConsents } from '../compliance/consent';
import { decision, type PolicyDecision } from '../compliance/decisions';
import { evaluateDnd, type DndService } from '../compliance/dnd';
import type { PolicyDecisionRepository } from '../compliance/repository';
import type { DeadLetterRepository } from '../dlq/repository';
import type { NotificationFactory } from '../notifications/factory';
import type { NotificationLifecycle } from '../notifications/lifecycle';
import type { NotificationRepository } from '../notifications/repository';
import type { DeliveryMessage, NotificationRow } from '../notifications/types';
import { canRetry, computeRetryDelay } from '../retries/backoff';
import type { RedisRetryScheduler } from '../retries/retry-scheduler';
import type { BudgetTracker } from '../routing/budget';
import { evaluateQuietHours } from '../scheduling/quiet-hours';
import type { EventDefinition, EventTaxonomy } from '../taxonomy/taxonomy';
import type { TemplateEngine } from '../templates/engine';
import type { UserContextService } from '../users/context';
import type { UserRepository } from '../users/repository';
import type { ContactChannel } from '../users/contacts';
import type { CircuitBreaker } from './circuit-breaker';
import { ProviderError, type DeliveryRequest } from './provider';
import type { ProviderEntry, ProviderRegistry } from './registry';

const ACTOR = 'delivery-worker';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

export type DispatchOutcome = 'ack' | 'poison' | 'requeue';

interface AttemptSummary {
  provider: string;
  outcome: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  kind?: string;
  code?: string;
}

export interface DispatcherDeps {
  db: Knex;
  redis: Redis;
  notifications: NotificationRepository;
  lifecycle: NotificationLifecycle;
  factory: NotificationFactory;
  registry: ProviderRegistry;
  circuit: CircuitBreaker;
  rateLimiter: RateLimiter;
  users: UserRepository;
  userContext: UserContextService;
  decisions: PolicyDecisionRepository;
  dnd: DndService;
  retries: RedisRetryScheduler;
  dlq: DeadLetterRepository;
  budget: BudgetTracker;
  templates: TemplateEngine;
  taxonomy: EventTaxonomy;
  policy: NotificationPolicy;
  topology: RabbitTopology;
  clock: Clock;
  random: RandomSource;
  logger: Logger;
  /** Replays receipts that raced ahead of the SENT commit. */
  webhooks?: { reconcile(trx: Knex.Transaction, n: NotificationRow): Promise<NotificationRow> };
  lockTtlMs?: number;
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError('TRANSIENT', 'UNEXPECTED', errorMessage(err));
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, ms);
  try {
    return await Promise.race([
      fn(ctrl.signal),
      new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener(
          'abort',
          () => {
            reject(
              new ProviderError('TIMEOUT', 'TIMEOUT', `Provider did not respond within ${ms}ms`),
            );
          },
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivery worker logic for one RabbitMQ message. Guarantees:
 *  - at most one worker processes a notification at a time (Redis lock),
 *  - stale/duplicate messages are acknowledged without side effects,
 *  - every provider call is recorded as a delivery attempt BEFORE it is made,
 *  - a provider success that was not committed (crash) is recovered without resending,
 *  - the message is acked only after the outcome is committed to PostgreSQL.
 */
export class DeliveryDispatcher {
  constructor(private readonly d: DispatcherDeps) {}

  async handle(msg: DeliveryMessage): Promise<DispatchOutcome> {
    const lockKey = `lock:notif:${msg.notificationId}`;
    const token = randomUUID();
    const acquired = await this.d.redis.set(lockKey, token, 'PX', this.d.lockTtlMs ?? 120000, 'NX');
    if (acquired !== 'OK') return 'requeue';
    try {
      return await this.process(msg);
    } finally {
      await this.d.redis.eval(RELEASE_LOCK, 1, lockKey, token).catch(() => undefined);
    }
  }

  private async process(msg: DeliveryMessage): Promise<DispatchOutcome> {
    const n = await this.d.notifications.find(msg.notificationId, msg.createdAt);
    if (!n) {
      this.d.logger.error(
        { notificationId: msg.notificationId },
        'delivery message references unknown notification',
      );
      return 'poison';
    }
    if (n.state !== 'QUEUED' && n.state !== 'RETRYING') return 'ack';
    if (msg.retry < n.retry_count) return 'ack';
    const def = this.d.taxonomy.get(n.event_type);
    const ctx = { actor: ACTOR, correlationId: n.correlation_id };

    // Crash recovery: a provider accepted the message but the outcome was never committed.
    const prior = (await this.d
      .db('delivery_attempts')
      .where({ notification_id: n.id })
      .orderBy('started_at')) as {
      id: string;
      status: string;
      provider: string;
      provider_message_id: string | null;
      cost_micros: number;
      attempt_number: number;
    }[];
    const recovered = prior.find((a) => a.status === 'SUCCESS' && a.provider_message_id);
    if (recovered?.provider_message_id && !n.provider_message_id) {
      await this.sent(
        n,
        recovered.provider,
        recovered.provider_message_id,
        recovered.cost_micros,
        Math.max(n.attempt_count, recovered.attempt_number),
        'recovered committed provider acceptance after worker restart',
      );
      return 'ack';
    }
    await this.d
      .db('delivery_attempts')
      .where({ notification_id: n.id, status: 'PENDING' })
      .update({
        status: 'UNKNOWN',
        error_kind: 'UNKNOWN',
        error_message: 'worker stopped before the outcome was recorded',
        completed_at: this.d.clock.now(),
      });

    // Edge case: preferences/consent/DND changed between routing and dispatch.
    const { block, checked } = await this.recheck(n, def);
    const decisionRow = (d: PolicyDecision) => ({
      decision: d,
      eventId: n.event_id,
      notificationId: n.id,
      userId: n.user_id,
      correlationId: n.correlation_id,
    });
    if (block) {
      await this.d.db.transaction(async (trx) => {
        const to = block.rule.startsWith('DND_') ? 'DND' : 'SUPPRESSED';
        await this.d.lifecycle.transition(trx, n, to, { ...ctx, reason: block.rule });
        await this.d.decisions.insert(trx, [decisionRow(block)]);
      });
      if (block.rule.startsWith('DND_'))
        metrics.dndBlocks.inc({ classification: n.regulatory_class });
      return 'ack';
    }
    // Audit proof that DND was checked immediately before this send (TRAI audit, PDF B2.3).
    await this.d.decisions.insert(this.d.db, checked.map(decisionRow));

    let recipient = n.user_id;
    let contactId: string | null = null;
    if (n.channel !== 'inapp') {
      const contact = await this.d.users.activeContact(n.user_id, n.channel as ContactChannel);
      if (!contact) {
        await this.permanentFailure(
          n,
          def,
          new ProviderError(
            'INVALID_RECIPIENT',
            'NO_ACTIVE_CONTACT',
            `No active ${n.channel} contact`,
          ),
          null,
          n.attempt_count,
        );
        return 'ack';
      }
      recipient = contact.value;
      contactId = contact.id;
    }
    if (!n.content) {
      await this.permanentFailure(
        n,
        def,
        new ProviderError('PERMANENT', 'NO_CONTENT', 'Notification has no rendered content'),
        null,
        n.attempt_count,
      );
      return 'ack';
    }

    const req: DeliveryRequest = {
      notificationId: n.id,
      channel: n.channel,
      recipient,
      content: n.content,
      priority: n.priority,
      correlationId: n.correlation_id,
      userId: n.user_id,
    };
    const entries = await this.d.registry.ordered(n.channel);
    const summary: AttemptSummary[] = [];
    let attemptNo = n.attempt_count;
    let lastError: ProviderError | null = null;
    let retryHintMs = 0;

    for (const entry of entries) {
      if (!(await this.d.circuit.acquire(entry.name))) {
        summary.push({ provider: entry.name, outcome: 'SKIPPED', kind: 'CIRCUIT_OPEN' });
        retryHintMs = Math.max(retryHintMs, await this.d.circuit.remainingOpenMs(entry.name));
        continue;
      }
      const rl = await this.d.rateLimiter.consume(
        `provider:${entry.name}`,
        entry.rate_limit_per_minute,
        60000,
      );
      if (!rl.allowed) {
        summary.push({ provider: entry.name, outcome: 'SKIPPED', kind: 'RATE_LIMITED' });
        retryHintMs = Math.max(retryHintMs, rl.retryAfterMs);
        lastError = new ProviderError(
          'RATE_LIMITED',
          'LOCAL_RATE_LIMIT',
          `Local rate limit for ${entry.name} reached`,
        );
        continue;
      }
      const check = entry.provider.validateRecipient(recipient);
      if (!check.valid) {
        await this.permanentFailure(
          n,
          def,
          new ProviderError(
            'INVALID_RECIPIENT',
            'RECIPIENT_FORMAT',
            check.reason ?? 'invalid recipient',
          ),
          contactId,
          attemptNo,
        );
        return 'ack';
      }
      attemptNo++;
      const result = await this.attempt(n, entry, req, attemptNo);
      if (result.ok) {
        await this.sent(n, entry.name, result.providerMessageId, result.costMicros, attemptNo);
        return 'ack';
      }
      const pe = result.error;
      summary.push({ provider: entry.name, outcome: 'FAILED', kind: pe.kind, code: pe.code });
      lastError = pe;
      if (pe.options.retryAfterMs) retryHintMs = Math.max(retryHintMs, pe.options.retryAfterMs);
      if (!pe.retryable) {
        await this.permanentFailure(n, def, pe, contactId, attemptNo);
        return 'ack';
      }
      // retryable: fail over to the next provider in priority order
    }
    await this.transientFailure(
      n,
      def,
      lastError ??
        new ProviderError(
          'TRANSIENT',
          'NO_PROVIDER_AVAILABLE',
          `No ${n.channel} provider available`,
        ),
      summary,
      attemptNo,
      retryHintMs,
    );
    return 'ack';
  }

  private async attempt(
    n: NotificationRow,
    entry: ProviderEntry,
    req: DeliveryRequest,
    attemptNo: number,
  ): Promise<
    | { ok: true; providerMessageId: string; costMicros: number }
    | { ok: false; error: ProviderError }
  > {
    const [attempt] = (await this.d
      .db('delivery_attempts')
      .insert({
        notification_id: n.id,
        attempt_number: attemptNo,
        provider: entry.name,
        channel: n.channel,
        status: 'PENDING',
        started_at: this.d.clock.now(),
      })
      .returning('id')) as { id: string }[];
    if (!attempt) throw new Error('delivery attempt insert failed');
    const started = Date.now();
    try {
      const res = await withTimeout(entry.timeout_ms, (signal) => entry.provider.send(req, signal));
      const latency = Date.now() - started;
      await this.d.db('delivery_attempts').where({ id: attempt.id }).update({
        status: 'SUCCESS',
        provider_message_id: res.providerMessageId,
        cost_micros: res.costMicros,
        completed_at: this.d.clock.now(),
        latency_ms: latency,
      });
      await this.d.circuit.recordSuccess(entry.name);
      metrics.providerRequests.inc({
        provider: entry.name,
        channel: n.channel,
        status: 'success',
      });
      metrics.providerDuration.observe({ provider: entry.name }, latency / 1000);
      return { ok: true, providerMessageId: res.providerMessageId, costMicros: res.costMicros };
    } catch (err) {
      const pe = toProviderError(err);
      const latency = Date.now() - started;
      await this.d
        .db('delivery_attempts')
        .where({ id: attempt.id })
        .update({
          status: 'FAILED',
          error_kind: pe.kind,
          error_code: pe.code.slice(0, 64),
          error_message: scrubString(pe.message).slice(0, 500),
          completed_at: this.d.clock.now(),
          latency_ms: latency,
        });
      if (pe.countsAgainstProvider) {
        const status = await this.d.circuit.recordFailure(entry.name);
        if (status === 'OPEN') this.d.logger.warn({ provider: entry.name }, 'circuit breaker open');
      } else {
        // The provider answered coherently (e.g. invalid recipient): it is healthy.
        await this.d.circuit.recordSuccess(entry.name);
      }
      metrics.providerRequests.inc({
        provider: entry.name,
        channel: n.channel,
        status: pe.kind.toLowerCase(),
      });
      metrics.providerDuration.observe({ provider: entry.name }, latency / 1000);
      this.d.logger.warn(
        { notificationId: n.id, provider: entry.name, kind: pe.kind, code: pe.code },
        'provider attempt failed',
      );
      return { ok: false, error: pe };
    }
  }

  private async sent(
    n: NotificationRow,
    providerName: string,
    providerMessageId: string,
    costMicros: number,
    attemptNo: number,
    reason?: string,
  ): Promise<void> {
    const now = this.d.clock.now();
    const patch = {
      provider: providerName,
      provider_message_id: providerMessageId,
      attempt_count: attemptNo,
      cost_micros: costMicros,
      last_error_code: null,
      last_error_message: null,
      next_attempt_at: null,
    };
    await this.d.db.transaction(async (trx) => {
      const current = await this.d.notifications.lock(trx, n.id, n.created_at);
      if (!current) return;
      if (current.state === 'QUEUED' || current.state === 'RETRYING') {
        const sent = await this.d.lifecycle.transition(trx, current, 'SENT', {
          actor: ACTOR,
          correlationId: n.correlation_id,
          at: now,
          reason: reason ?? null,
          metadata: { provider: providerName },
          patch,
        });
        await this.d.webhooks?.reconcile(trx, sent);
      } else {
        // A client ack / receipt already advanced the row (e.g. DELIVERED):
        // record the provider details without moving the state backwards.
        await trx('notifications')
          .where({ id: n.id, created_at: n.created_at })
          .update({ ...patch, sent_at: current.sent_at ?? now, updated_at: now });
      }
    });
    await this.d.budget.add(n.channel, costMicros, now).catch(() => undefined);
    metrics.sendLatency.observe(
      { channel: n.channel, priority: n.priority },
      (now.getTime() - new Date(n.created_at).getTime()) / 1000,
    );
  }

  private async recheck(
    n: NotificationRow,
    def: EventDefinition | undefined,
  ): Promise<{ block: PolicyDecision | null; checked: PolicyDecision[] }> {
    if (!def || n.is_digest) return { block: null, checked: [] };
    const ctx = await this.d.userContext.load(n.user_id, { fresh: true });
    if (ctx.user.status !== 'ACTIVE')
      return {
        block: decision(
          n.channel,
          'USER_INACTIVE',
          'BLOCK',
          `User became ${ctx.user.status} before dispatch`,
        ),
        checked: [],
      };
    if (!n.via_override && n.parent_notification_id === null) {
      const prefs = ctx.preferences;
      if (!prefs.channels[n.channel] || !prefs.categories[def.category].enabled) {
        return {
          block: decision(
            n.channel,
            'PREFERENCE_CHANGED_BEFORE_DISPATCH',
            'BLOCK',
            `User disabled ${n.channel}/${def.category} after routing (preference v${n.preference_version ?? '?'} → v${ctx.preferenceVersion})`,
            {
              routedWithVersion: n.preference_version,
              currentVersion: ctx.preferenceVersion,
            },
          ),
          checked: [],
        };
      }
    }
    const consent = evaluateConsent(n.channel, def.regulatoryClass, latestConsents(ctx.consents));
    if (consent.outcome === 'BLOCK') return { block: consent, checked: [] };
    // TRAI: the DND check is the LAST step before an SMS leaves (PDF p.46), so a
    // number registered after routing (deferral, retry, backlog) is still honoured.
    if (!this.d.policy.dnd.appliesToChannels.includes(n.channel))
      return { block: null, checked: [] };
    const phoneHash = ctx.contacts.find(
      (c) => c.channel === n.channel && c.status === 'ACTIVE',
    )?.phoneHash;
    const dnd = evaluateDnd(
      phoneHash ? await this.d.dnd.lookup(phoneHash) : null,
      def.regulatoryClass,
      n.channel,
      this.d.policy.dnd,
    );
    dnd.metadata = {
      ...dnd.metadata,
      stage: 'DISPATCH',
      checkedAt: this.d.clock.now().toISOString(),
    };
    return dnd.outcome === 'BLOCK' ? { block: dnd, checked: [] } : { block: null, checked: [dnd] };
  }

  private async permanentFailure(
    n: NotificationRow,
    def: EventDefinition | undefined,
    pe: ProviderError,
    contactId: string | null,
    attemptNo: number,
  ): Promise<void> {
    const bounce = n.channel === 'email' && pe.kind === 'INVALID_RECIPIENT';
    await this.d.db.transaction(async (trx) => {
      if (pe.kind === 'INVALID_RECIPIENT' && contactId)
        await this.d.users.markContactInvalid(contactId, `${pe.code}: ${pe.message}`, trx);
      const failed = await this.d.lifecycle.transition(trx, n, bounce ? 'BOUNCED' : 'FAILED', {
        actor: ACTOR,
        correlationId: n.correlation_id,
        reason: pe.code,
        metadata: { kind: pe.kind },
        patch: {
          attempt_count: attemptNo,
          last_error_code: pe.code.slice(0, 64),
          last_error_message: scrubString(pe.message).slice(0, 500),
          next_attempt_at: null,
        },
      });
      if (def) await this.fallback(trx, failed, def, `${pe.kind}:${pe.code}`);
    });
  }

  private async transientFailure(
    n: NotificationRow,
    def: EventDefinition | undefined,
    pe: ProviderError,
    summary: AttemptSummary[],
    attemptNo: number,
    retryHintMs: number,
  ): Promise<void> {
    const profile = this.d.policy.retryProfiles[n.priority];
    // retry_count is monotonic (stale-message detection); the budget restarts
    // from retry_budget_start after an operator's manual DLQ retry.
    const used = n.retry_count - n.retry_budget_start;
    const errorPatch = {
      attempt_count: attemptNo,
      last_error_code: pe.code.slice(0, 64),
      last_error_message: scrubString(pe.message).slice(0, 500),
    };
    if (canRetry(used, profile)) {
      const delay = Math.min(
        Math.max(computeRetryDelay(used, profile, this.d.random), retryHintMs),
        profile.maxDelayMs,
      );
      const nextAt = new Date(this.d.clock.now().getTime() + delay);
      const retry = n.retry_count + 1;
      await this.d.db.transaction(async (trx) => {
        await this.d.lifecycle.transition(trx, n, 'RETRYING', {
          actor: ACTOR,
          correlationId: n.correlation_id,
          reason: pe.code,
          metadata: { retry, delayMs: delay, attempts: summary },
          patch: { ...errorPatch, retry_count: retry, next_attempt_at: nextAt },
        });
      });
      // After commit: if this ZADD is lost, the stale sweep re-enqueues from next_attempt_at.
      await this.d.retries.schedule(n, retry, nextAt).catch((err: unknown) => {
        this.d.logger.warn(
          { err: errorMessage(err), notificationId: n.id },
          'retry not added to Redis schedule; sweep will recover it',
        );
      });
      metrics.retries.inc({
        attempt: String(retry),
        provider: summary.at(-1)?.provider ?? n.provider ?? 'none',
      });
      return;
    }
    await this.d.db.transaction(async (trx) => {
      const dead = await this.d.lifecycle.transition(trx, n, 'DLQ', {
        actor: ACTOR,
        correlationId: n.correlation_id,
        reason: 'RETRIES_EXHAUSTED',
        metadata: { lastError: pe.code, attempts: summary },
        patch: { ...errorPatch, next_attempt_at: null },
      });
      const history = (await trx('delivery_attempts')
        .where({ notification_id: n.id })
        .orderBy('started_at')
        .select(
          'attempt_number',
          'provider',
          'status',
          'error_kind',
          'error_code',
          'started_at',
        )) as Record<string, unknown>[];
      const dlqId = await this.d.dlq.insert(trx, {
        source: 'DELIVERY',
        notificationId: n.id,
        eventId: n.event_id,
        channel: n.channel,
        reasonCode: 'RETRIES_EXHAUSTED',
        reasonMessage: `Delivery failed after ${used} retries: ${pe.code}`,
        attempts: attemptNo,
        retryHistory: history,
        payload: {
          notificationId: n.id,
          createdAt: new Date(n.created_at).toISOString(),
          channel: n.channel,
          priority: n.priority,
          eventType: n.event_type,
        },
      });
      await enqueueOutbox(trx, [
        {
          destination: 'RABBITMQ',
          exchange: this.d.topology.dlx,
          routingKey: 'exhausted',
          payload: { dlqId, notificationId: n.id, reason: 'RETRIES_EXHAUSTED' },
          headers: { 'x-correlation-id': n.correlation_id },
        },
      ]);
      if (def) await this.fallback(trx, dead, def, 'RETRIES_EXHAUSTED');
    });
  }

  /**
   * Fallback channel after a permanent failure or exhausted retries. Respects
   * current preferences, consent, contact availability and quiet hours; does not
   * consume frequency-cap budget again (it replaces a failed delivery).
   */
  private async fallback(
    trx: Knex.Transaction,
    failed: NotificationRow,
    def: EventDefinition,
    reason: string,
  ): Promise<void> {
    if (!failed.event_id || def.fallbackChannels.length === 0) return;
    const event = (await trx('financial_events')
      .where({ id: failed.event_id })
      .first('payload')) as { payload: Record<string, unknown> } | undefined;
    if (!event) return;
    const ctx = await this.d.userContext.load(failed.user_id);
    const consents = latestConsents(ctx.consents);
    for (const channel of def.fallbackChannels) {
      if (channel === failed.channel || !ctx.preferences.channels[channel]) continue;
      if (
        channel !== 'inapp' &&
        !ctx.contacts.some((c) => c.channel === channel && c.status === 'ACTIVE')
      )
        continue;
      if (evaluateConsent(channel, def.regulatoryClass, consents).outcome === 'BLOCK') continue;
      const exists = (await trx('notification_keys')
        .where({ dedupe_key: `evt:${failed.event_id}:${channel}` })
        .first('dedupe_key')) as { dedupe_key: string } | undefined;
      if (exists) continue;
      let content;
      try {
        content = await this.d.templates.render({
          eventType: def.code,
          channel,
          locale: ctx.preferences.locale,
          timezone: ctx.preferences.timezone,
          data: event.payload,
          user: { name: ctx.user.display_name },
        });
      } catch (err) {
        this.d.logger.warn({ err, channel }, 'fallback render failed');
        continue;
      }
      const row = await this.d.factory.create(
        trx,
        {
          dedupeKey: `evt:${failed.event_id}:${channel}`,
          eventId: failed.event_id,
          userId: failed.user_id,
          eventType: def.code,
          category: def.category,
          channel,
          priority: def.priority,
          regulatoryClass: def.regulatoryClass,
          locale: content.locale,
          content,
          preferenceVersion: ctx.preferenceVersion,
          parentNotificationId: failed.id,
          correlationId: failed.correlation_id,
        },
        ACTOR,
      );
      if (!row) continue;
      const tctx = {
        actor: ACTOR,
        correlationId: failed.correlation_id,
        reason: `fallback from ${failed.channel}`,
      };
      const routed = await this.d.factory.advance(trx, row, ['ENRICHED', 'ROUTED'], tctx);
      const q =
        this.d.policy.quietHours.appliesToChannels.includes(channel) && def.quietHours !== 'BYPASS'
          ? evaluateQuietHours(
              this.d.clock.now(),
              ctx.preferences.timezone,
              ctx.preferences.quietHours,
            )
          : { inQuietHours: false as const };
      if (q.inQuietHours && 'endsAt' in q && q.endsAt) {
        await this.d.lifecycle.transition(trx, routed, 'QUIET', {
          ...tctx,
          reason: 'QUIET_HOURS_DEFER',
        });
        await trx('scheduled_notifications').insert({
          kind: 'QUIET_RELEASE',
          user_id: row.user_id,
          notification_id: row.id,
          notification_created_at: row.created_at,
          due_at: q.endsAt,
        });
      } else {
        await this.d.factory.queue(trx, routed, tctx);
      }
      await this.d.decisions.insert(trx, [
        {
          decision: decision(
            channel,
            'FALLBACK_CHANNEL',
            'FALLBACK',
            `${failed.channel} delivery failed (${reason}); falling back to ${channel}`,
            { parentNotificationId: failed.id },
          ),
          eventId: failed.event_id,
          notificationId: row.id,
          userId: row.user_id,
          correlationId: row.correlation_id,
        },
      ]);
      return;
    }
  }
}
