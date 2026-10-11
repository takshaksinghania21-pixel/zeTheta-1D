import { z } from 'zod';
import type { Container } from '../../container';
import { ForbiddenError, NotFoundError } from '../../common/errors';
import { hasPermission } from '../../modules/auth/permissions';
import type { Principal } from '../../modules/auth/service';
import type { NotificationRow } from '../../modules/notifications/types';
import type { Api } from '../http';
import { camel, toNotificationDto } from '../mappers';
import {
  CategoryEnum,
  ChannelEnum,
  NotificationSchema,
  PageOf,
  PaginationQuery,
  StateEnum,
  UuidParam,
} from '../schemas';

const NotificationPageSchema = PageOf(NotificationSchema, 'NotificationPage');

const AttemptSchema = z.object({
  id: z.uuid(),
  attemptNumber: z.number(),
  provider: z.string(),
  channel: z.string(),
  status: z.string(),
  errorKind: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  costMicros: z.number(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
});
const HistorySchema = z.object({
  id: z.uuid(),
  fromState: z.string().nullable(),
  toState: z.string(),
  actor: z.string(),
  correlationId: z.string(),
  reason: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});

/** USER principals may only see their own notifications; ADMIN/OPERATOR may see any. */
export async function loadVisible(
  c: Container,
  principal: Principal,
  id: string,
): Promise<NotificationRow> {
  const n = await c.notifications().find(id);
  if (!n) throw new NotFoundError('Notification', id);
  if (hasPermission(principal.roles, 'notifications:read:any')) return n;
  if (principal.userId && n.user_id === principal.userId) return n;
  throw new NotFoundError('Notification', id); // do not leak existence
}

export function registerNotificationRoutes(api: Api, c: Container): void {
  const readAuth = { anyOf: ['notifications:read:any', 'notifications:read:own'] } as const;

  api.route({
    method: 'get',
    path: '/notifications',
    operationId: 'listNotifications',
    summary: 'List notifications (own for USER tokens; any user for operators via userId)',
    tags: ['Notifications'],
    auth: { anyOf: [...readAuth.anyOf] },
    query: PaginationQuery.extend({
      userId: z.uuid().optional(),
      eventId: z.uuid().optional(),
      state: StateEnum.optional(),
      channel: ChannelEnum.optional(),
      category: CategoryEnum.optional(),
      unreadOnly: z
        .enum(['true', 'false'])
        .optional()
        .transform((v) => v === 'true'),
    }),
    responses: { 200: { description: 'Page of notifications', schema: NotificationPageSchema } },
    handler: async ({ query, actor }) => {
      const p = actor;
      let userId = query.userId;
      if (!hasPermission(p.roles, 'notifications:read:any')) {
        if (!p.userId) throw new ForbiddenError();
        if (userId && userId !== p.userId)
          throw new ForbiddenError('Cannot list another user’s notifications');
        userId = p.userId;
      }
      const page = await c.notifications().list({
        ...(userId ? { userId } : {}),
        ...(query.eventId ? { eventId: query.eventId } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.category ? { category: query.category } : {}),
        unreadOnly: query.unreadOnly,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
      return {
        status: 200,
        body: { items: page.items.map(toNotificationDto), nextCursor: page.nextCursor },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/notifications/:id',
    operationId: 'getNotification',
    summary: 'Get a notification by id',
    tags: ['Notifications'],
    auth: { anyOf: [...readAuth.anyOf] },
    params: UuidParam,
    responses: {
      200: { description: 'Notification', schema: NotificationSchema },
      404: { description: 'Not found (or not visible)' },
    },
    handler: async ({ params, actor }) => ({
      status: 200,
      body: toNotificationDto(await loadVisible(c, actor, params.id)),
    }),
  });

  api.route({
    method: 'get',
    path: '/notifications/:id/attempts',
    operationId: 'getNotificationAttempts',
    summary: 'Delivery attempts for a notification (provider, outcome, error classification)',
    tags: ['Notifications'],
    auth: { anyOf: [...readAuth.anyOf] },
    params: UuidParam,
    responses: {
      200: { description: 'Attempts', schema: z.object({ items: z.array(AttemptSchema) }) },
      404: { description: 'Not found' },
    },
    handler: async ({ params, actor }) => {
      await loadVisible(c, actor, params.id);
      const rows = await c.notifications().attempts(params.id);
      return {
        status: 200,
        body: { items: rows.map((r) => ({ ...camel(r), notificationId: undefined })) },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/notifications/:id/history',
    operationId: 'getNotificationHistory',
    summary: 'Full state-transition history (with actor, correlation id and reason)',
    tags: ['Notifications'],
    auth: { anyOf: [...readAuth.anyOf] },
    params: UuidParam,
    responses: {
      200: { description: 'History', schema: z.object({ items: z.array(HistorySchema) }) },
      404: { description: 'Not found' },
    },
    handler: async ({ params, actor }) => {
      await loadVisible(c, actor, params.id);
      return {
        status: 200,
        body: { items: (await c.notifications().history(params.id)).map(camel) },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/notifications/:id/read',
    operationId: 'markNotificationRead',
    summary: 'Mark an in-app notification as read (owner only, idempotent)',
    tags: ['Notifications'],
    auth: { permission: 'notifications:act:own' },
    params: UuidParam,
    responses: {
      200: { description: 'Updated notification', schema: NotificationSchema },
      404: { description: 'Not found' },
      409: { description: 'Not an in-app notification or not deliverable yet' },
    },
    handler: async ({ params, actor, correlationId }) => ({
      status: 200,
      body: toNotificationDto(
        await c.notificationService().markRead(actor.userId ?? '', params.id, correlationId),
      ),
    }),
  });

  api.route({
    method: 'post',
    path: '/notifications/:id/click',
    operationId: 'recordNotificationClick',
    summary: 'Record a click on an in-app or push notification (click-through analytics)',
    tags: ['Notifications'],
    auth: { permission: 'notifications:act:own' },
    params: UuidParam,
    responses: {
      200: { description: 'Updated notification', schema: NotificationSchema },
      404: { description: 'Not found' },
    },
    handler: async ({ params, actor, correlationId }) => ({
      status: 200,
      body: toNotificationDto(
        await c.notificationService().recordClick(actor.userId ?? '', params.id, correlationId),
      ),
    }),
  });

  api.route({
    method: 'get',
    path: '/deliveries/:id/status',
    operationId: 'getDeliveryStatus',
    summary: 'Delivery status: persisted state plus a live provider status query where supported',
    tags: ['Delivery'],
    auth: { permission: 'delivery:read' },
    params: UuidParam,
    responses: {
      200: {
        description: 'Delivery status',
        schema: z.object({
          notificationId: z.uuid(),
          state: StateEnum,
          provider: z.string().nullable(),
          providerMessageId: z.string().nullable(),
          providerStatus: z
            .object({ status: z.string(), errorCode: z.string().optional() })
            .nullable(),
          lastAttempt: AttemptSchema.nullable(),
        }),
      },
      404: { description: 'Not found' },
    },
    handler: async ({ params }) => {
      const n = await c.notifications().require(params.id);
      const attempts = await c.notifications().attempts(n.id);
      const last = attempts[attempts.length - 1];
      let providerStatus: { status: string; errorCode?: string } | null = null;
      const provider = n.provider ? c.registry().get(n.provider) : undefined;
      if (provider && n.provider_message_id) {
        try {
          const s = await provider.getStatus(n.provider_message_id);
          providerStatus = { status: s.status, ...(s.errorCode ? { errorCode: s.errorCode } : {}) };
        } catch {
          providerStatus = { status: 'UNAVAILABLE' };
        }
      }
      return {
        status: 200,
        body: {
          notificationId: n.id,
          state: n.state,
          provider: n.provider,
          providerMessageId: n.provider_message_id,
          providerStatus,
          lastAttempt: last ? { ...camel(last), notificationId: undefined } : null,
        },
      };
    },
  });
}
