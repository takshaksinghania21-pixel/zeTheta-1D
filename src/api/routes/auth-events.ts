import { z } from 'zod';
import type { Container } from '../../container';
import { NotFoundError } from '../../common/errors';
import { eventEnvelopeSchema } from '../../modules/events/ingestion';
import type { Api } from '../http';
import { camel, toNotificationDto } from '../mappers';
import { NotificationSchema, PolicyDecisionSchema, UuidParam } from '../schemas';

const EventEnvelopeSchema = eventEnvelopeSchema.meta({ id: 'EventEnvelope' });

const TokenPairSchema = z
  .object({
    accessToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number(),
    refreshToken: z.string().optional(),
    refreshExpiresIn: z.number().optional(),
  })
  .meta({ id: 'TokenPair' });

const TokenRequest = z
  .discriminatedUnion('grantType', [
    z.strictObject({
      grantType: z.literal('password'),
      username: z.string().min(1).max(100),
      password: z.string().min(1).max(200),
    }),
    z.strictObject({
      grantType: z.literal('client_credentials'),
      clientId: z.string().min(1).max(100),
      clientSecret: z.string().min(1).max(200),
    }),
    z.strictObject({
      grantType: z.literal('refresh_token'),
      refreshToken: z.string().min(10).max(200),
    }),
  ])
  .meta({ id: 'TokenRequest' });

const IngestResponse = z
  .object({
    eventId: z.uuid(),
    status: z.enum(['ACCEPTED', 'DUPLICATE']),
    idempotencyKey: z.string(),
    statusUrl: z.string(),
  })
  .meta({ id: 'IngestResponse' });

const BatchResponse = z
  .object({
    batchId: z.uuid(),
    accepted: z.number(),
    duplicates: z.number(),
    rejected: z.number(),
    results: z.array(
      z.object({
        index: z.number(),
        status: z.enum(['ACCEPTED', 'DUPLICATE', 'REJECTED']),
        eventId: z.uuid().optional(),
        error: z
          .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
          .optional(),
      }),
    ),
  })
  .meta({ id: 'BatchIngestResponse' });

const EventStatusSchema = z
  .object({
    id: z.uuid(),
    eventType: z.string(),
    category: z.string(),
    userId: z.uuid(),
    source: z.string(),
    idempotencyKey: z.string(),
    status: z.string(),
    statusReason: z.string().nullable(),
    occurredAt: z.string(),
    receivedAt: z.string(),
    processedAt: z.string().nullable(),
    correlationId: z.string(),
    notifications: z.array(NotificationSchema),
    decisions: z.array(PolicyDecisionSchema),
  })
  .meta({ id: 'EventStatus' });

const EventDefinitionSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    category: z.string(),
    priority: z.string(),
    regulatoryClass: z.string(),
    permittedChannels: z.array(z.string()),
    defaultChannels: z.array(z.string()),
    fallbackChannels: z.array(z.string()),
    mandatoryChannels: z.array(z.string()),
    latencyObjectiveMs: z.number(),
    quietHours: z.string(),
    frequencyCapExempt: z.boolean(),
    idempotencyKeyFields: z.array(z.string()),
    retryPolicy: z.object({
      maxRetries: z.number(),
      baseDelayMs: z.number(),
      maxDelayMs: z.number(),
      jitterMaxMs: z.number(),
    }),
    payload: z.record(z.string(), z.record(z.string(), z.unknown())),
  })
  .meta({ id: 'EventDefinition' });

export function registerAuthAndEventRoutes(api: Api, c: Container): void {
  api.route({
    method: 'post',
    path: '/auth/token',
    operationId: 'issueToken',
    summary: 'Issue access tokens (password, client_credentials or refresh_token grant)',
    tags: ['Auth'],
    auth: 'public',
    rateLimit: 'auth',
    body: TokenRequest,
    responses: { 200: { description: 'Token pair', schema: TokenPairSchema } },
    handler: async ({ body }) => {
      const auth = c.auth();
      const pair =
        body.grantType === 'password'
          ? await auth.passwordGrant(body.username, body.password)
          : body.grantType === 'client_credentials'
            ? await auth.clientCredentials(body.clientId, body.clientSecret)
            : await auth.refresh(body.refreshToken);
      return { status: 200, body: pair, headers: { 'cache-control': 'no-store' } };
    },
  });

  api.route({
    method: 'post',
    path: '/auth/revoke',
    operationId: 'revokeToken',
    summary: 'Revoke a refresh token family (logout)',
    tags: ['Auth'],
    auth: 'public',
    rateLimit: 'auth',
    body: z.strictObject({ refreshToken: z.string().min(10).max(200) }),
    responses: { 204: { description: 'Revoked (also returned for unknown tokens)' } },
    handler: async ({ body }) => {
      await c.auth().revoke(body.refreshToken);
      return { status: 204 };
    },
  });

  api.route({
    method: 'post',
    path: '/auth/user-token',
    operationId: 'mintUserToken',
    summary: 'Mint a short-lived USER token for an end user (trusted auth gateway only)',
    tags: ['Auth'],
    auth: { permission: 'auth:user-token' },
    body: z.strictObject({ userId: z.uuid() }),
    responses: { 200: { description: 'Access token for the user', schema: TokenPairSchema } },
    handler: async ({ body, actor }) => {
      const pair = await c.auth().mintUserToken(body.userId);
      await c.audit().record({
        actorId: actor.id,
        actorRole: actor.roles.join(','),
        action: 'USER_TOKEN_MINTED',
        targetType: 'user',
        targetId: body.userId,
      });
      return { status: 200, body: pair, headers: { 'cache-control': 'no-store' } };
    },
  });

  api.route({
    method: 'get',
    path: '/taxonomy/events',
    operationId: 'listEventTypes',
    summary: 'List registered financial event types',
    tags: ['Taxonomy'],
    auth: { permission: 'taxonomy:read' },
    responses: {
      200: {
        description: 'Event definitions',
        schema: z.object({
          version: z.number(),
          count: z.number(),
          items: z.array(EventDefinitionSchema),
        }),
      },
    },
    handler: () => {
      const items = c.taxonomy.list().map((d) => ({
        code: d.code,
        name: d.name,
        category: d.category,
        priority: d.priority,
        regulatoryClass: d.regulatoryClass,
        permittedChannels: d.permittedChannels,
        defaultChannels: d.defaultChannels,
        fallbackChannels: d.fallbackChannels,
        mandatoryChannels: d.mandatoryChannels,
        latencyObjectiveMs: d.latencyObjectiveMs,
        quietHours: d.quietHours,
        frequencyCapExempt: d.frequencyCapExempt,
        idempotencyKeyFields: d.idempotencyKeyFields,
        retryPolicy: c.policy.retryProfiles[d.priority],
        payload: d.fields as unknown as Record<string, Record<string, unknown>>,
      }));
      return Promise.resolve({
        status: 200,
        body: { version: c.taxonomy.version, count: items.length, items },
      });
    },
  });

  api.route({
    method: 'post',
    path: '/events',
    operationId: 'ingestEvent',
    summary: 'Submit a financial event for asynchronous processing',
    description:
      'Validates the envelope and payload against the taxonomy, de-duplicates by (source, idempotencyKey) and publishes the event via the transactional outbox. Returns 202 for new events and 200 for exact duplicates; 409 if the key was used with a different payload.',
    tags: ['Events'],
    auth: { permission: 'events:ingest' },
    body: EventEnvelopeSchema,
    responses: {
      202: { description: 'Accepted for processing', schema: IngestResponse },
      200: { description: 'Duplicate of an earlier event', schema: IngestResponse },
      409: { description: 'Idempotency key reused with a different payload' },
      422: { description: 'Unknown event type or payload schema violation' },
    },
    handler: async ({ body, actor, correlationId }) => {
      const r = await c.ingestion().ingest(body, actor.username, correlationId);
      return {
        status: r.status === 'ACCEPTED' ? 202 : 200,
        body: {
          eventId: r.eventId,
          status: r.status,
          idempotencyKey: r.idempotencyKey,
          statusUrl: `/api/v1/events/${r.eventId}`,
        },
        headers: { location: `/api/v1/events/${r.eventId}` },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/events/batch',
    operationId: 'ingestEventBatch',
    summary: 'Submit up to 500 financial events; each item is validated independently',
    tags: ['Events'],
    auth: { permission: 'events:ingest' },
    body: z.strictObject({ events: z.array(z.unknown()).min(1).max(500) }),
    responses: { 202: { description: 'Per-item results', schema: BatchResponse } },
    handler: async ({ body, actor, correlationId }) => {
      const { batchId, results } = await c
        .ingestion()
        .ingestBatch(body.events, actor.username, correlationId, actor.id);
      return {
        status: 202,
        body: {
          batchId,
          accepted: results.filter((r) => r.status === 'ACCEPTED').length,
          duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
          rejected: results.filter((r) => r.status === 'REJECTED').length,
          results,
        },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/events/batches/:id',
    operationId: 'getIngestionBatch',
    summary: 'Ingestion status of a batch',
    tags: ['Events'],
    auth: { permission: 'events:read' },
    params: UuidParam,
    responses: {
      200: {
        description: 'Batch status',
        schema: z.object({
          batch: z.record(z.string(), z.unknown()),
          statusCounts: z.record(z.string(), z.number()),
        }),
      },
      404: { description: 'Unknown batch' },
    },
    handler: async ({ params }) => {
      const r = await c.ingestion().getBatch(params.id);
      if (!r) throw new NotFoundError('Batch', params.id);
      return { status: 200, body: { batch: camel(r.batch), statusCounts: r.statusCounts } };
    },
  });

  api.route({
    method: 'get',
    path: '/events/:id',
    operationId: 'getEventStatus',
    summary: 'Processing status of an event, with resulting notifications and policy decisions',
    tags: ['Events'],
    auth: { permission: 'events:read' },
    params: UuidParam,
    responses: {
      200: { description: 'Event status', schema: EventStatusSchema },
      404: { description: 'Unknown event' },
    },
    handler: async ({ params }) => {
      const e = await c.ingestion().getEvent(params.id);
      if (!e) throw new NotFoundError('Event', params.id);
      const [notifications, decisions] = await Promise.all([
        c.notifications().byEvent(e.id),
        c.decisions().list({ eventId: e.id, limit: 200 }),
      ]);
      const {
        payload: _payload,
        payload_hash: _hash,
        batch_id: _batch,
        scrubbed_at: _scrubbed,
        ...rest
      } = e as unknown as Record<string, unknown>;
      return {
        status: 200,
        body: {
          ...camel(rest),
          notifications: notifications.map(toNotificationDto),
          decisions: decisions.map(camel),
        },
      };
    },
  });
}
