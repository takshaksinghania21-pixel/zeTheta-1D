import type { NotificationRow } from '../database/models/notification';

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

export function toNotificationDto(n: NotificationRow): Record<string, unknown> {
  return {
    id: n.id,
    eventId: n.event_id,
    userId: n.user_id,
    eventType: n.event_type,
    category: n.category,
    channel: n.channel,
    priority: n.priority,
    state: n.state,
    locale: n.locale,
    title: n.content?.title ?? n.content?.subject ?? null,
    body: n.content?.body ?? null,
    viaOverride: n.via_override,
    isDigest: n.is_digest,
    parentNotificationId: n.parent_notification_id,
    attemptCount: n.attempt_count,
    retryCount: n.retry_count - n.retry_budget_start,
    provider: n.provider,
    lastErrorCode: n.last_error_code,
    createdAt: iso(n.created_at),
    queuedAt: iso(n.queued_at),
    sentAt: iso(n.sent_at),
    deliveredAt: iso(n.delivered_at),
    readAt: iso(n.read_at),
    clickedAt: iso(n.clicked_at),
    nextAttemptAt: iso(n.next_attempt_at),
  };
}

/** snake_case DB row → camelCase API object, with dates serialised as ISO strings. */
export function camel(row: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] =
      v instanceof Date ? v.toISOString() : v;
  }
  return out;
}
