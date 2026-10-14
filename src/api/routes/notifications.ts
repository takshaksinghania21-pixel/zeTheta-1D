import { z } from 'zod';
import type { Container } from '../../container';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { hasPermission } from '../middleware/permissions';
import type { Principal } from '../middleware/auth-service';
import type { NotificationRow } from '../../database/models/notification';
import type { Api } from '../middleware/http';
import { camel, toNotificationDto } from '../mappers';
import { PRIORITY_NUMBER, pdfChannel } from '../validators/pdf-contract';
import {
  NotificationDetailSchema,
  CategoryEnum,
  ChannelEnum,
  NotificationSchema,
  PageOf,
  PaginationQuery,
  StateEnum,
  UuidParam,
} from '../validators/schemas';

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
    description:
      'Includes the PDF Appendix A fields (p.65–66): `priority` is the §A8 number (1 = CRITICAL … 5 = LOW; the label is in `priorityLabel`), `channel` uses `in_app`, plus `state_history` and the `compliance` evidence (DND check timestamp and result, classification, regulatory override, frequency-cap result).',
    responses: {
      200: { description: 'Notification', schema: NotificationDetailSchema },
      404: { description: 'Not found (or not visible)' },
    },
    handler: async ({ params, actor }) => {
      const n = await loadVisible(c, actor, params.id);
      const [history, own, eventLevel] = await Promise.all([
        c.notifications().history(n.id),
        c.decisions().list({ notificationId: n.id, limit: 100 }),
        n.event_id ? c.decisions().list({ eventId: n.event_id, limit: 200 }) : [],
      ]);
      const decisions = [
        ...own,
        ...eventLevel.filter((d) => d.channel === n.channel || d.channel === null),
      ];
      const dnd = decisions
        .filter((d) => String(d.rule).startsWith('DND_'))
        .sort((a, b) => +new Date(b.created_at as Date) - +new Date(a.created_at as Date))[0];
      const capped = n.state === 'CAPPED';
      const capChecked = decisions.some((d) => String(d.rule).startsWith('FREQUENCY_'));
      const dto = toNotificationDto(n);
      return {
        status: 200,
        body: {
          ...dto,
          priority: PRIORITY_NUMBER[n.priority],
          priorityLabel: n.priority,
          channel: pdfChannel(n.channel),
          notification_id: n.id,
          event_type: n.event_type,
          user_id: n.user_id,
          status: n.state,
          template_id: n.template_version ? `${n.event_type}-v${n.template_version}` : null,
          external_id: n.provider_message_id,
          delivery_attempts: n.attempt_count,
          rendered_content: n.content
            ? {
                body: n.content.body,
                ...(n.content.title ? { title: n.content.title } : {}),
                ...(n.content.subject ? { subject: n.content.subject } : {}),
              }
            : null,
          state_history: history.map((h) => ({
            status: h.to_state,
            timestamp: new Date(h.created_at as Date).toISOString(),
            actor: h.actor,
            ...(h.metadata && Object.keys(h.metadata as object).length > 0
              ? { metadata: h.metadata }
              : {}),
          })),
          compliance: {
            dnd_checked: dnd !== undefined,
            dnd_check_timestamp: dnd ? new Date(dnd.created_at as Date).toISOString() : null,
            dnd_result: dnd
              ? ((dnd.metadata as { dndStatus?: string } | null)?.dndStatus ??
                String(dnd.rule).replace('DND_', ''))
              : null,
            classification: n.regulatory_class,
            regulatory_override: n.via_override,
            frequency_cap_checked: capChecked,
            frequency_cap_result: capped ? 'CAPPED' : capChecked ? 'WITHIN_LIMITS' : null,
          },
          cost_paisa: Math.round(n.cost_micros / 10000),
          created_at: new Date(n.created_at).toISOString(),
          delivered_at: n.delivered_at ? new Date(n.delivered_at).toISOString() : null,
          latency_ms: n.delivered_at
            ? new Date(n.delivered_at).getTime() - new Date(n.created_at).getTime()
            : null,
        },
      };
    },
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
