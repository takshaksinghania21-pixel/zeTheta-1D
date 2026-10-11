import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { CATEGORIES, CHANNELS, LOCALES, NOTIFICATION_STATES, PRIORITIES } from '../domain/types';

extendZodWithOpenApi(z);

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z
        .array(
          z.object({
            path: z.string().optional(),
            message: z.string(),
            code: z.string().optional(),
          }),
        )
        .optional(),
      correlationId: z.string().optional(),
    }),
  })
  .meta({ id: 'Error' });

export const UuidParam = z.object({ id: z.uuid() });
export const UserIdParam = z.object({ userId: z.uuid() });
export const ChannelEnum = z.enum(CHANNELS).meta({ id: 'Channel' });
export const LocaleEnum = z.enum(LOCALES).meta({ id: 'Locale' });
export const CategoryEnum = z.enum(CATEGORIES).meta({ id: 'Category' });
export const StateEnum = z.enum(NOTIFICATION_STATES).meta({ id: 'NotificationState' });
export const PriorityEnum = z.enum(PRIORITIES).meta({ id: 'Priority' });
export const IsoDate = z.string().meta({ format: 'date-time' });

export const PaginationQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export const RenderedContentSchema = z
  .object({
    channel: ChannelEnum,
    locale: LocaleEnum,
    requestedLocale: LocaleEnum,
    templateVersion: z.number(),
    subject: z.string().optional(),
    title: z.string().optional(),
    body: z.string(),
    html: z.string().optional(),
    sms: z
      .object({
        encoding: z.enum(['GSM-7', 'UCS-2']),
        segments: z.number(),
        truncated: z.boolean(),
      })
      .optional(),
    missingVariables: z.array(z.string()),
  })
  .meta({ id: 'RenderedContent' });

export const NotificationSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid().nullable(),
    userId: z.uuid(),
    eventType: z.string(),
    category: z.string(),
    channel: ChannelEnum,
    priority: PriorityEnum,
    state: StateEnum,
    locale: LocaleEnum,
    title: z.string().nullable(),
    body: z.string().nullable(),
    viaOverride: z.boolean(),
    isDigest: z.boolean(),
    parentNotificationId: z.uuid().nullable(),
    attemptCount: z.number().int(),
    retryCount: z.number().int(),
    provider: z.string().nullable(),
    lastErrorCode: z.string().nullable(),
    createdAt: IsoDate,
    queuedAt: IsoDate.nullable(),
    sentAt: IsoDate.nullable(),
    deliveredAt: IsoDate.nullable(),
    readAt: IsoDate.nullable(),
    clickedAt: IsoDate.nullable(),
    nextAttemptAt: IsoDate.nullable(),
  })
  .meta({ id: 'Notification' });

export const PageOf = <T extends z.ZodType>(item: T, id: string) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() }).meta({ id });

export const PolicyDecisionSchema = z
  .object({
    id: z.uuid(),
    eventId: z.uuid().nullable(),
    notificationId: z.uuid().nullable(),
    userId: z.uuid(),
    channel: z.string().nullable(),
    rule: z.string(),
    outcome: z.string(),
    explanation: z.string(),
    metadata: z.record(z.string(), z.unknown()),
    correlationId: z.string(),
    createdAt: IsoDate,
  })
  .meta({ id: 'PolicyDecision' });
