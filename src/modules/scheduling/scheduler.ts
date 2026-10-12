import { hostname } from 'node:os';
import type { Knex } from 'knex';
import type { Clock } from '../../common/clock';
import { errorMessage } from '../../common/errors';
import type { Logger } from '../../common/logger';
import type { NotificationPolicy } from '../../config/policy';
import type { Channel } from '../../domain/types';
import type { FrequencyCapper } from '../frequency/frequency-capper';
import type { NotificationFactory } from '../notifications/factory';
import type { NotificationLifecycle } from '../notifications/lifecycle';
import type { NotificationRow } from '../notifications/types';
import type { EventTaxonomy } from '../taxonomy/taxonomy';
import type { TemplateEngine } from '../templates/engine';
import { DIGEST_EVENT_TYPE } from '../templates/source';
import type { UserContextService } from '../users/context';

const ACTOR = 'scheduler';

interface JobRow {
  id: string;
  kind: 'QUIET_RELEASE' | 'DIGEST';
  user_id: string;
  notification_id: string | null;
  notification_created_at: Date | null;
  due_at: Date;
  attempts: number;
}

export interface SchedulerDeps {
  db: Knex;
  policy: NotificationPolicy;
  taxonomy: EventTaxonomy;
  capper: FrequencyCapper;
  factory: NotificationFactory;
  lifecycle: NotificationLifecycle;
  templates: TemplateEngine;
  userContext: UserContextService;
  clock: Clock;
  logger: Logger;
  retentionDays: number;
  staleSeconds: number;
}

/**
 * Durable scheduling backed by PostgreSQL (`scheduled_notifications`): jobs
 * survive restarts, are claimed with SKIP LOCKED (safe with several schedulers)
 * and are re-claimed if a scheduler dies mid-job.
 */
export class Scheduler {
  private readonly workerId = `${hostname()}:${process.pid}`;

  constructor(private readonly d: SchedulerDeps) {}

  /** Claims and processes due jobs. Returns the number of jobs handled. */
  async runDue(limit = 200): Promise<number> {
    const now = this.d.clock.now();
    const jobs = (await this.d.db.raw(
      `UPDATE scheduled_notifications SET status = 'PROCESSING', locked_by = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
       WHERE id IN (SELECT id FROM scheduled_notifications WHERE status = 'PENDING' AND due_at <= ? ORDER BY due_at LIMIT ? FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [this.workerId, now, now, now, limit],
    )) as { rows: JobRow[] };
    const byUser = new Map<string, JobRow[]>();
    for (const j of jobs.rows) byUser.set(j.user_id, [...(byUser.get(j.user_id) ?? []), j]);
    for (const [userId, userJobs] of byUser) {
      try {
        const quiet = userJobs.filter((j) => j.kind === 'QUIET_RELEASE');
        if (quiet.length > 0) await this.releaseQuiet(userId, quiet);
        for (const job of userJobs.filter((j) => j.kind === 'DIGEST')) await this.sendDigest(job);
      } catch (err) {
        this.d.logger.error({ err, userId }, 'scheduled job failed');
        await this.d
          .db('scheduled_notifications')
          .whereIn(
            'id',
            userJobs.map((j) => j.id),
          )
          .whereNot({ status: 'DONE' })
          .update({
            status: this.d.db.raw(`CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END`),
            last_error: errorMessage(err).slice(0, 500),
            locked_by: null,
            locked_at: null,
          });
      }
    }
    return jobs.rows.length;
  }

  private async complete(trx: Knex.Transaction, ids: string[]): Promise<void> {
    await trx('scheduled_notifications')
      .whereIn('id', ids)
      .update({ status: 'DONE', locked_by: null, updated_at: this.d.clock.now() });
  }

  /** Releases deferred notifications at the end of quiet hours, folding >N into a digest. */
  private async releaseQuiet(userId: string, jobs: JobRow[]): Promise<void> {
    await this.d.db.transaction(async (trx) => {
      const rows: NotificationRow[] = [];
      for (const j of jobs) {
        if (!j.notification_id) continue;
        const n = (await trx('notifications')
          .where({ id: j.notification_id, created_at: j.notification_created_at })
          .forUpdate()
          .first()) as NotificationRow | undefined;
        if (n?.state === 'QUIET') rows.push(n);
      }
      const logicalEvents = new Set(rows.map((r) => r.event_id ?? r.id));
      if (logicalEvents.size > this.d.policy.quietHours.morningDigestThreshold) {
        await this.foldIntoDigest(trx, userId, rows, 'QUIET_HOURS_MORNING_DIGEST');
      } else {
        // Caps count logical events, so one event's channels are checked together.
        const byEvent = new Map<string, NotificationRow[]>();
        for (const n of rows) {
          const key = n.event_id ?? n.id;
          byEvent.set(key, [...(byEvent.get(key) ?? []), n]);
        }
        for (const [eventRef, group] of byEvent) {
          const def = this.d.taxonomy.get(group[0]?.event_type ?? '');
          const cap = await this.d.capper.checkAndConsume({
            userId,
            eventRef,
            category: def?.category ?? 'MARKET',
            cooldownSubject: `release:${eventRef}`,
            channels: group.map((n) => n.channel),
            exempt: def?.frequencyCapExempt ?? false,
            now: this.d.clock.now(),
          });
          for (const n of group) {
            const ctx = { actor: ACTOR, correlationId: n.correlation_id };
            if (cap.allowedChannels.includes(n.channel))
              await this.d.factory.queue(trx, n, { ...ctx, reason: 'QUIET_HOURS_ENDED' });
            else
              await this.d.lifecycle.transition(trx, n, 'CAPPED', {
                ...ctx,
                reason: `FREQUENCY_CAP_${cap.blocked.find((b) => b.channel === n.channel)?.scope ?? cap.blocked[0]?.scope ?? 'CHANNEL'}`,
              });
          }
        }
      }
      await this.complete(
        trx,
        jobs.map((j) => j.id),
      );
    });
  }

  /** Delivers a preference-driven digest of DIGESTED notifications. */
  private async sendDigest(job: JobRow): Promise<void> {
    await this.d.db.transaction(async (trx) => {
      const rows = (await trx('notifications')
        .where({ user_id: job.user_id, state: 'DIGESTED', is_digest: false })
        .whereNull('digest_id')
        .andWhere('created_at', '<=', job.due_at)
        .orderBy('created_at')
        .limit(100)
        .forUpdate()) as NotificationRow[];
      if (rows.length > 0)
        await this.foldIntoDigest(trx, job.user_id, rows, 'SCHEDULED_DIGEST', job.id);
      await this.complete(trx, [job.id]);
    });
  }

  private async foldIntoDigest(
    trx: Knex.Transaction,
    userId: string,
    rows: NotificationRow[],
    reason: string,
    jobId?: string,
  ): Promise<void> {
    const ctx = await this.d.userContext.load(userId);
    const preferred: Channel[] =
      reason === 'SCHEDULED_DIGEST'
        ? ['email', 'push', 'inapp']
        : ['push', 'sms', 'whatsapp', 'inapp'];
    const channels = new Set(rows.map((r) => r.channel));
    const channel =
      preferred.find(
        (c) =>
          (reason === 'SCHEDULED_DIGEST' || channels.has(c) || c === 'inapp') &&
          ctx.preferences.channels[c] &&
          (c === 'inapp' || ctx.contacts.some((x) => x.channel === c && x.status === 'ACTIVE')),
      ) ?? 'inapp';
    // One digest line per logical event (an event deferred on push AND sms appears once).
    const seen = new Set<string>();
    const items: { title: string }[] = [];
    for (const r of rows) {
      const key = r.event_id ?? r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ title: r.content?.title ?? r.content?.subject ?? r.event_type });
    }
    const content = await this.d.templates.render({
      eventType: DIGEST_EVENT_TYPE,
      channel,
      locale: ctx.preferences.locale,
      timezone: ctx.preferences.timezone,
      data: { count: items.length, items },
      user: { name: ctx.user.display_name },
    });
    const correlationId = rows[0]?.correlation_id ?? `digest-${userId}`;
    const digest = await this.d.factory.create(
      trx,
      {
        dedupeKey: `digest:${
          jobId ??
          rows
            .map((r) => r.id)
            .sort()
            .join(',')
            .slice(0, 200)
        }:${channel}`,
        eventId: null,
        userId,
        eventType: DIGEST_EVENT_TYPE,
        category: 'DIGEST',
        channel,
        priority: 'LOW',
        regulatoryClass: 'SERVICE',
        locale: content.locale,
        content,
        preferenceVersion: ctx.preferenceVersion,
        isDigest: true,
        correlationId,
      },
      ACTOR,
    );
    if (!digest) return;
    const tctx = { actor: ACTOR, correlationId, reason, metadata: { items: rows.length } };
    const routed = await this.d.factory.advance(trx, digest, ['ENRICHED', 'ROUTED'], tctx);
    await this.d.factory.queue(trx, routed, tctx);
    for (const n of rows) {
      if (n.state === 'QUIET') {
        await this.d.lifecycle.transition(trx, n, 'DIGESTED', {
          actor: ACTOR,
          correlationId: n.correlation_id,
          reason,
          patch: { digest_id: digest.id },
        });
      } else {
        await trx('notifications')
          .where({ id: n.id, created_at: n.created_at })
          .update({ digest_id: digest.id, updated_at: this.d.clock.now() });
      }
    }
  }

  /**
   * Crash recovery sweeps:
   *  - jobs stuck in PROCESSING (scheduler died) go back to PENDING,
   *  - QUEUED/RETRYING notifications whose message may have been lost are
   *    re-enqueued (duplicates are harmless: the dispatcher de-duplicates).
   */
  async sweep(): Promise<{ jobs: number; notifications: number }> {
    const cutoff = new Date(this.d.clock.now().getTime() - this.d.staleSeconds * 1000);
    const jobs = await this.d
      .db('scheduled_notifications')
      .where({ status: 'PROCESSING' })
      .andWhere('locked_at', '<', cutoff)
      .update({ status: 'PENDING', locked_by: null, locked_at: null });
    const stale = (await this.d
      .db('notifications')
      .where(function staleRows() {
        this.where({ state: 'RETRYING' }).andWhere('next_attempt_at', '<', cutoff);
      })
      .orWhere(function staleQueued() {
        this.where({ state: 'QUEUED' }).andWhere('queued_at', '<', cutoff);
      })
      .limit(500)) as NotificationRow[];
    for (const n of stale) {
      await this.d.factory.enqueueDelivery(this.d.db, n, n.retry_count);
      await this.d
        .db('notifications')
        .where({ id: n.id, created_at: n.created_at })
        .update({
          next_attempt_at: new Date(this.d.clock.now().getTime() + this.d.staleSeconds * 1000),
          queued_at: this.d.clock.now(),
        });
    }
    if (stale.length > 0)
      this.d.logger.warn({ count: stale.length }, 're-enqueued stale notifications');
    return { jobs, notifications: stale.length };
  }

  async maintainPartitions(): Promise<number> {
    const res = (await this.d.db.raw('SELECT ensure_notification_partitions(1, 3) AS created')) as {
      rows: { created: number }[];
    };
    return res.rows[0]?.created ?? 0;
  }

  /**
   * Data retention: personalisation (rendered content, event payloads, error
   * text) older than the retention period is scrubbed; ids, states, channels,
   * timestamps and costs are kept for analytics.
   */
  async runRetention(): Promise<Record<string, number>> {
    const cutoff = new Date(this.d.clock.now().getTime() - this.d.retentionDays * 86400000);
    const notifications = await this.d
      .db('notifications')
      .where('created_at', '<', cutoff)
      .whereNull('scrubbed_at')
      .update({ content: null, last_error_message: null, scrubbed_at: this.d.clock.now() });
    const events = await this.d
      .db('financial_events')
      .where('received_at', '<', cutoff)
      .whereNull('scrubbed_at')
      .update({
        payload: JSON.stringify({}),
        status_reason: null,
        scrubbed_at: this.d.clock.now(),
      });
    const outbox = await this.d
      .db('outbox')
      .whereNotNull('published_at')
      .andWhere('published_at', '<', new Date(this.d.clock.now().getTime() - 86400000))
      .del();
    const idempotency = await this.d
      .db('idempotency_records')
      .where('expires_at', '<', this.d.clock.now())
      .del();
    const analyticsDedup = await this.d
      .db('analytics_processed')
      .where('processed_at', '<', new Date(this.d.clock.now().getTime() - 7 * 86400000))
      .del();
    const webhooks = await this.d.db('webhook_receipts').where('received_at', '<', cutoff).del();
    this.d.logger.info({ notifications, events }, 'retention run complete');
    return { notifications, events, outbox, idempotency, analyticsDedup, webhooks };
  }
}
