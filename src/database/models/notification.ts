import type {
  Category,
  Channel,
  Locale,
  NotificationState,
  Priority,
  RegulatoryClass,
} from '../../utils/types';
import type { RenderedContent } from '../../templates/engine/engine';

export interface NotificationRow {
  id: string;
  created_at: Date;
  event_id: string | null;
  user_id: string;
  event_type: string;
  category: Category | 'DIGEST';
  channel: Channel;
  priority: Priority;
  regulatory_class: RegulatoryClass;
  state: NotificationState;
  locale: Locale;
  template_version: number | null;
  content: RenderedContent | null;
  preference_version: number | null;
  via_override: boolean;
  parent_notification_id: string | null;
  digest_id: string | null;
  is_digest: boolean;
  attempt_count: number;
  retry_count: number;
  /** retry_count value at which the current retry budget started (manual DLQ retries). */
  retry_budget_start: number;
  max_retries: number;
  next_attempt_at: Date | null;
  provider: string | null;
  provider_message_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  cost_micros: number;
  correlation_id: string;
  queued_at: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  clicked_at: Date | null;
  failed_at: Date | null;
  scrubbed_at: Date | null;
  updated_at: Date;
}

/** Message carried on RabbitMQ delivery queues (no PII, ids only). */
export interface DeliveryMessage {
  notificationId: string;
  createdAt: string;
  /** retry_count at publish time; stale duplicates are detected with it. */
  retry: number;
  correlationId: string;
}

/** Lifecycle event published to Kafka for analytics / downstream consumers. */
export interface LifecycleEvent {
  kind: 'TRANSITION' | 'ENGAGEMENT';
  transitionId: string;
  notificationId: string;
  eventId: string | null;
  userId: string;
  eventType: string;
  category: string;
  channel: Channel;
  priority: Priority;
  from: NotificationState | null;
  to: NotificationState | 'CLICKED';
  at: string;
  provider?: string | null;
  costMicros?: number;
  /** Milliseconds from notification creation to this transition. */
  sinceCreatedMs: number;
  reason?: string | null;
  correlationId: string;
}
