import { z } from 'zod';
import type { Container } from '../../container';
import { AppError, ForbiddenError, NotFoundError } from '../../common/errors';
import { hasPermission } from '../../modules/auth/permissions';
import { CHANNELS } from '../../domain/types';
import { consumerLag } from '../../infrastructure/kafka/kafka';
import { queueDepths } from '../../infrastructure/rabbitmq/rabbitmq';
import { MOCK_MODES } from '../../infrastructure/providers/mock';
import { consumerGroups } from '../../workers/workers';
import type { Api } from '../http';
import { clientIp } from '../http';
import { camel } from '../mappers';
import { ChannelEnum, UuidParam } from '../schemas';

const DlqEntrySchema = z
  .object({
    id: z.uuid(),
    source: z.string(),
    notificationId: z.uuid().nullable(),
    eventId: z.uuid().nullable(),
    channel: z.string().nullable(),
    reasonCode: z.string(),
    reasonMessage: z.string(),
    attempts: z.number(),
    retryHistory: z.array(z.unknown()),
    payload: z.record(z.string(), z.unknown()),
    status: z.string(),
    resolvedBy: z.string().nullable(),
    resolvedAt: z.string().nullable(),
    resolutionNote: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'DeadLetterEntry' });

const RangeQuery = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export function registerOpsRoutes(api: Api, c: Container): void {
  const range = (q: z.infer<typeof RangeQuery>) => {
    const to = q.to ? new Date(q.to) : new Date(c.clock.now().getTime() + 3600000);
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 24 * 3600000 - 3600000);
    if (from >= to) throw new AppError('VALIDATION_ERROR', 400, '`from` must be before `to`');
    if (to.getTime() - from.getTime() > 93 * 86400000)
      throw new AppError('VALIDATION_ERROR', 400, 'Range may not exceed 93 days');
    return { from, to };
  };

  // ---- DLQ ---------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/dlq',
    operationId: 'listDeadLetters',
    summary: 'List dead-letter entries with failure reasons',
    tags: ['DLQ'],
    auth: { permission: 'dlq:read' },
    query: z.strictObject({
      status: z.enum(['OPEN', 'RETRIED', 'RESOLVED', 'DISCARDED']).optional(),
      source: z.enum(['DELIVERY', 'EVENT', 'POISON']).optional(),
      channel: ChannelEnum.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
    }),
    responses: {
      200: {
        description: 'Entries',
        schema: z.object({ items: z.array(DlqEntrySchema), total: z.number() }),
      },
    },
    handler: async ({ query }) => {
      const r = await c.dlqRepo().list(query);
      return { status: 200, body: { items: r.items.map(camel), total: r.total } };
    },
  });

  api.route({
    method: 'get',
    path: '/dlq/:id',
    operationId: 'getDeadLetter',
    summary: 'Dead-letter entry with retry history and delivery attempts',
    tags: ['DLQ'],
    auth: { permission: 'dlq:read' },
    params: UuidParam,
    responses: {
      200: {
        description: 'Entry',
        schema: DlqEntrySchema.extend({
          attempts: z.number(),
          deliveryAttempts: z.array(z.record(z.string(), z.unknown())),
        }),
      },
      404: { description: 'Not found' },
    },
    handler: async ({ params }) => {
      const e = await c.dlqRepo().require(params.id);
      const attempts = e.notification_id ? await c.notifications().attempts(e.notification_id) : [];
      return { status: 200, body: { ...camel(e), deliveryAttempts: attempts.map(camel) } };
    },
  });

  api.route({
    method: 'post',
    path: '/dlq/:id/retry',
    operationId: 'retryDeadLetter',
    summary: 'Manually retry a dead-letter entry (fresh retry budget); audited',
    tags: ['DLQ'],
    auth: { permission: 'dlq:retry' },
    params: UuidParam,
    body: z.strictObject({ note: z.string().max(500).optional() }),
    responses: {
      200: { description: 'Retried', schema: DlqEntrySchema },
      409: { description: 'Entry not OPEN or not retryable' },
    },
    handler: async ({ params, body, actor }) => {
      const r = await c
        .dlq()
        .retry(params.id, { id: actor.id, role: actor.roles.join(',') }, body.note);
      (await c.outboxRelay().catch(() => null))?.kick();
      return { status: 200, body: camel(r) };
    },
  });

  api.route({
    method: 'post',
    path: '/dlq/:id/resolve',
    operationId: 'resolveDeadLetter',
    summary: 'Resolve (handled out-of-band) or discard (ADMIN only) a dead-letter entry; audited',
    tags: ['DLQ'],
    auth: { anyOf: ['dlq:resolve', 'dlq:discard'] },
    params: UuidParam,
    body: z.strictObject({
      resolution: z.enum(['RESOLVED', 'DISCARDED']),
      note: z.string().min(3).max(500),
    }),
    responses: {
      200: { description: 'Resolved', schema: DlqEntrySchema },
      409: { description: 'Entry not OPEN' },
    },
    handler: async ({ params, body, actor }) => {
      if (body.resolution === 'DISCARDED' && !hasPermission(actor.roles, 'dlq:discard'))
        throw new ForbiddenError('Only ADMIN may discard dead-letter entries');
      if (body.resolution === 'RESOLVED' && !hasPermission(actor.roles, 'dlq:resolve'))
        throw new ForbiddenError();
      return {
        status: 200,
        body: camel(
          await c
            .dlq()
            .resolve(
              params.id,
              body.resolution,
              { id: actor.id, role: actor.roles.join(',') },
              body.note,
            ),
        ),
      };
    },
  });

  // ---- operations -------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/ops/queues',
    operationId: 'getQueueStats',
    summary: 'RabbitMQ queue depths, Kafka consumer lag, outbox backlog and open DLQ entries',
    tags: ['Operations'],
    auth: { permission: 'ops:read' },
    responses: {
      200: {
        description: 'Queue statistics',
        schema: z.object({
          rabbitmq: z.record(z.string(), z.object({ messages: z.number(), consumers: z.number() })),
          kafkaLag: z.record(z.string(), z.number().nullable()),
          outboxBacklog: z.number(),
          dlqOpen: z.number(),
          scheduledPending: z.number(),
        }),
      },
    },
    handler: async () => {
      const rabbit = await queueDepths(c.rabbit(), [
        ...CHANNELS.map((ch) => c.topology.deliveryQueue(ch)),
        c.topology.dlqQueue,
      ]);
      const groups = consumerGroups(c.config.KAFKA_TOPIC_PREFIX);
      const kafkaLag: Record<string, number | null> = {};
      const admin = c.kafka().admin();
      try {
        await admin.connect();
        kafkaLag[groups.events] = await consumerLag(admin, groups.events, c.topics.financialEvents);
        kafkaLag[groups.analytics] = await consumerLag(admin, groups.analytics, c.topics.lifecycle);
      } catch {
        kafkaLag[groups.events] = null;
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
      const [backlog] = (await c.db()('outbox').whereNull('published_at').count({ n: '*' })) as {
        n: string;
      }[];
      const [pending] = (await c
        .db()('scheduled_notifications')
        .where({ status: 'PENDING' })
        .count({ n: '*' })) as { n: string }[];
      return {
        status: 200,
        body: {
          rabbitmq: rabbit,
          kafkaLag,
          outboxBacklog: Number(backlog?.n ?? 0),
          dlqOpen: await c.dlqRepo().openCount(),
          scheduledPending: Number(pending?.n ?? 0),
        },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/ops/providers',
    operationId: 'listProviders',
    summary: 'Provider configuration, circuit-breaker state and quota',
    tags: ['Operations'],
    auth: { permission: 'ops:read' },
    responses: {
      200: {
        description: 'Providers',
        schema: z.object({ mode: z.string(), items: z.array(z.record(z.string(), z.unknown())) }),
      },
    },
    handler: async () => ({
      status: 200,
      body: { mode: c.config.PROVIDER_MODE, items: await c.registry().status() },
    }),
  });

  api.route({
    method: 'patch',
    path: '/ops/providers/:name',
    operationId: 'updateProvider',
    summary: 'Enable/disable a provider or change its failover priority / rate limit; audited',
    tags: ['Operations'],
    auth: { permission: 'ops:write' },
    params: z.object({ name: z.string().regex(/^[a-z0-9-]{2,64}$/) }),
    body: z.strictObject({
      enabled: z.boolean().optional(),
      priority: z.number().int().min(1).max(1000).optional(),
      rateLimitPerMinute: z.number().int().min(1).max(1000000).optional(),
      resetCircuit: z.boolean().optional(),
    }),
    responses: {
      200: {
        description: 'Updated',
        schema: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
      },
      404: { description: 'Unknown provider' },
    },
    handler: async ({ params, body, actor }) => {
      if (!c.registry().get(params.name)) throw new NotFoundError('Provider', params.name);
      await c.registry().updateConfig(
        params.name,
        {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.rateLimitPerMinute !== undefined
            ? { rate_limit_per_minute: body.rateLimitPerMinute }
            : {}),
        },
        actor.id,
      );
      if (body.resetCircuit) await c.circuit().reset(params.name);
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'PROVIDER_UPDATED',
        targetType: 'provider',
        targetId: params.name,
        metadata: body,
      });
      return { status: 200, body: { items: await c.registry().status() } };
    },
  });

  api.route({
    method: 'post',
    path: '/ops/providers/:name/simulate',
    operationId: 'simulateProviderBehaviour',
    summary: 'Inject failures into a MOCK provider (disabled outside PROVIDER_MODE=mock)',
    tags: ['Operations'],
    auth: { permission: 'ops:write' },
    params: z.object({ name: z.string().regex(/^mock-[a-z0-9-]{1,60}$/) }),
    body: z.strictObject({
      mode: z.enum(MOCK_MODES),
      remaining: z.number().int().min(1).max(10000).nullable().default(null),
    }),
    responses: {
      200: {
        description: 'Behaviour set',
        schema: z.object({
          provider: z.string(),
          mode: z.string(),
          remaining: z.number().nullable(),
        }),
      },
      404: { description: 'Unknown provider' },
      403: { description: 'Not in mock mode' },
    },
    handler: async ({ params, body, actor }) => {
      if (c.config.PROVIDER_MODE !== 'mock' || c.config.NODE_ENV === 'production')
        throw new ForbiddenError('Failure injection is only available in mock mode');
      if (!c.registry().get(params.name)) throw new NotFoundError('Provider', params.name);
      await c.mockStore().set(params.name, { mode: body.mode, remaining: body.remaining });
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'MOCK_PROVIDER_SIMULATION',
        targetType: 'provider',
        targetId: params.name,
        metadata: body,
      });
      return {
        status: 200,
        body: { provider: params.name, ...(await c.mockStore().get(params.name)) },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/ops/retention/run',
    operationId: 'runRetention',
    summary:
      'Run the data-retention scrub now (personalisation older than RETENTION_DAYS); audited',
    tags: ['Operations'],
    auth: { permission: 'ops:write' },
    responses: { 200: { description: 'Rows affected', schema: z.record(z.string(), z.number()) } },
    handler: async ({ actor, req }) => {
      const r = await c.scheduler().runRetention();
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'RETENTION_RUN',
        targetType: 'system',
        metadata: { ...r, ip: clientIp(req) },
      });
      return { status: 200, body: r };
    },
  });

  api.route({
    method: 'get',
    path: '/ops/audit',
    operationId: 'listAuditLogs',
    summary: 'Audit log of privileged operations',
    tags: ['Operations'],
    auth: { permission: 'audit:read' },
    query: z.strictObject({
      targetType: z.string().max(64).optional(),
      targetId: z.string().max(100).optional(),
      action: z.string().max(64).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }),
    responses: {
      200: {
        description: 'Entries',
        schema: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
      },
    },
    handler: async ({ query }) => ({
      status: 200,
      body: { items: (await c.audit().list(query)).map(camel) },
    }),
  });

  api.route({
    method: 'get',
    path: '/rate-limit/status',
    operationId: 'getRateLimitStatus',
    summary: 'Current rate-limit usage for the calling principal',
    tags: ['Security'],
    auth: 'authenticated',
    responses: {
      200: {
        description: 'Usage',
        schema: z.object({
          principal: z.string(),
          limits: z.record(
            z.string(),
            z.object({ limit: z.number(), remaining: z.number(), resetSeconds: z.number() }),
          ),
        }),
      },
    },
    handler: async ({ actor }) => {
      const scopes = {
        standard: c.config.RATE_LIMIT_STANDARD_PER_MIN,
        preferences: c.config.RATE_LIMIT_PREFERENCES_PER_MIN,
      };
      const limits: Record<string, { limit: number; remaining: number; resetSeconds: number }> = {};
      for (const [scope, limit] of Object.entries(scopes)) {
        const r = await c.rateLimiter().peek(`${scope}:principal:${actor.id}`, limit, 60000);
        limits[scope] = {
          limit,
          remaining: r.remaining,
          resetSeconds: Math.ceil(r.resetMs / 1000),
        };
      }
      return { status: 200, body: { principal: actor.id, limits } };
    },
  });

  // ---- analytics ------------------------------------------------------------------
  const analyticsRoute = (
    path: string,
    operationId: string,
    summary: string,
    fn: (r: { from: Date; to: Date }, q: Record<string, unknown>) => Promise<unknown>,
    extraQuery: z.ZodRawShape = {},
  ): void => {
    api.route({
      method: 'get',
      path: `/analytics/${path}`,
      operationId,
      summary,
      tags: ['Analytics'],
      auth: { permission: 'analytics:read' },
      query: RangeQuery.extend(extraQuery),
      responses: { 200: { description: 'Metrics', schema: z.record(z.string(), z.unknown()) } },
      handler: async ({ query }) => {
        const r = range(query as z.infer<typeof RangeQuery>);
        return {
          status: 200,
          body: {
            range: { from: r.from.toISOString(), to: r.to.toISOString() },
            data: await fn(r, query),
          },
        };
      },
    });
  };
  analyticsRoute(
    'delivery',
    'getDeliveryRates',
    'Delivery, acceptance and failure rates by channel or event type',
    (r, q) => c.analytics().deliveryRates(r, q.groupBy === 'eventType' ? 'event_type' : 'channel'),
    { groupBy: z.enum(['channel', 'eventType']).default('channel') },
  );
  analyticsRoute(
    'latency',
    'getLatencyPercentiles',
    'P50/P95/P99 send and delivery latency per channel',
    (r, q) => c.analytics().latency(r, typeof q.channel === 'string' ? q.channel : undefined),
    { channel: ChannelEnum.optional() },
  );
  analyticsRoute(
    'engagement',
    'getEngagement',
    'Read/open and click-through rates where the channel can measure them',
    (r) => c.analytics().engagement(r),
  );
  analyticsRoute(
    'failures',
    'getFailures',
    'Failure rate by provider and top failure reasons',
    (r) => c.analytics().failures(r),
  );
  analyticsRoute('opt-outs', 'getOptOuts', 'Rolling 30-day opt-out rate', () =>
    c.analytics().optOuts(c.clock.now()),
  );
  analyticsRoute(
    'costs',
    'getCosts',
    'Delivery cost per channel and per delivered notification',
    (r) => c.analytics().costs(r),
  );
  analyticsRoute(
    'frequency-caps',
    'getFrequencyCapStats',
    'Frequency-cap hit rate and open digest suggestions',
    (r) => c.analytics().frequencyCaps(r),
  );
  analyticsRoute('summary', 'getAnalyticsSummary', 'All analytics in one response', (r) =>
    c.analytics().summary(r, c.clock.now()),
  );
}
