import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Process-wide Prometheus registry. Each process (API / worker) exposes its own
 * /metrics endpoint; Prometheus aggregates across instances.
 */
export const registry = new Registry();
let defaultsCollected = false;

export function enableDefaultMetrics(service: string): void {
  if (defaultsCollected) return;
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  defaultsCollected = true;
}

const latencyBuckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

export const metrics = {
  httpRequests: new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests by route and status',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  }),
  httpDuration: new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  }),
  // Names and labels of the notification_* / kafka_* / delivery_* metrics follow PDF §A11.1.
  eventsIngested: new Counter({
    name: 'notification_events_received_total',
    help: 'Financial events received by the ingestion API, by outcome',
    labelNames: ['event_type', 'priority', 'outcome'] as const,
    registers: [registry],
  }),
  eventsProcessed: new Counter({
    name: 'events_processed_total',
    help: 'Financial events processed by the consumer',
    labelNames: ['event_type', 'outcome'] as const,
    registers: [registry],
  }),
  transitions: new Counter({
    name: 'notification_transitions_total',
    help: 'Notification state transitions',
    labelNames: ['to_state', 'channel'] as const,
    registers: [registry],
  }),
  providerRequests: new Counter({
    name: 'notification_delivery_total',
    help: 'Provider delivery attempts by status',
    labelNames: ['channel', 'provider', 'status'] as const,
    registers: [registry],
  }),
  providerDuration: new Histogram({
    name: 'provider_request_duration_seconds',
    help: 'Provider send latency',
    labelNames: ['provider'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [registry],
  }),
  deliveryLatency: new Histogram({
    name: 'notification_delivery_latency_seconds',
    help: 'Time from notification creation to delivery confirmation',
    labelNames: ['channel', 'priority'] as const,
    buckets: latencyBuckets,
    registers: [registry],
  }),
  sendLatency: new Histogram({
    name: 'notification_send_latency_seconds',
    help: 'Time from notification creation to provider acceptance',
    labelNames: ['channel', 'priority'] as const,
    buckets: latencyBuckets,
    registers: [registry],
  }),
  capHits: new Counter({
    name: 'notification_frequency_cap_hits_total',
    help: 'Notifications blocked by frequency caps',
    labelNames: ['cap_type', 'event_type'] as const,
    registers: [registry],
  }),
  dndViolations: new Gauge({
    name: 'notification_dnd_violations',
    help: 'Promotional SMS sent in the last 24 h without a dispatch-time DND clearance (expected 0)',
    registers: [registry],
  }),
  dndBlocks: new Counter({
    name: 'notification_dnd_blocks_total',
    help: 'Notifications blocked by the DND registry',
    labelNames: ['classification'] as const,
    registers: [registry],
  }),
  quietDeferrals: new Counter({
    name: 'quiet_hours_deferrals_total',
    help: 'Notifications deferred by quiet hours',
    registers: [registry],
  }),
  quietBypasses: new Counter({
    name: 'quiet_hours_bypasses_total',
    help: 'Critical notifications that bypassed quiet hours',
    registers: [registry],
  }),
  retries: new Counter({
    name: 'notification_retry_total',
    help: 'Delivery retries scheduled',
    labelNames: ['attempt', 'provider'] as const,
    registers: [registry],
  }),
  dlqEntries: new Counter({
    name: 'dlq_entries_total',
    help: 'Entries written to the dead-letter queue',
    labelNames: ['source', 'reason'] as const,
    registers: [registry],
  }),
  retryQueueDepth: new Gauge({
    name: 'notification_retry_queue_depth',
    help: 'Retries waiting in the Redis retry schedule',
    registers: [registry],
  }),
  dlqOpen: new Gauge({
    name: 'notification_dlq_depth',
    help: 'Open dead-letter entries awaiting operator action',
    registers: [registry],
  }),
  consumerLag: new Gauge({
    name: 'kafka_consumer_lag',
    help: 'Kafka consumer lag in messages',
    labelNames: ['topic', 'partition', 'consumer_group'] as const,
    registers: [registry],
  }),
  circuitState: new Gauge({
    name: 'delivery_provider_circuit_state',
    help: 'Circuit breaker state: 0=closed 1=half-open 2=open',
    labelNames: ['provider'] as const,
    registers: [registry],
  }),
  outboxBacklog: new Gauge({
    name: 'outbox_backlog',
    help: 'Unpublished outbox messages',
    registers: [registry],
  }),
  queueDepth: new Gauge({
    name: 'rabbitmq_queue_depth',
    help: 'Messages ready in RabbitMQ queues',
    labelNames: ['queue'] as const,
    registers: [registry],
  }),
  webhooks: new Counter({
    name: 'webhooks_received_total',
    help: 'Provider callbacks by outcome',
    labelNames: ['provider', 'outcome'] as const,
    registers: [registry],
  }),
  rateLimited: new Counter({
    name: 'rate_limit_rejections_total',
    help: 'Requests rejected by the API rate limiter',
    labelNames: ['scope'] as const,
    registers: [registry],
  }),
  templateFailures: new Counter({
    name: 'template_render_failures_total',
    help: 'Template rendering failures',
    labelNames: ['event_type', 'channel'] as const,
    registers: [registry],
  }),
  smsTruncations: new Counter({
    name: 'sms_truncations_total',
    help: 'SMS bodies truncated to the segment limit',
    registers: [registry],
  }),
};
