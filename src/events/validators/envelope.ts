import { z } from 'zod';

/** Native ingestion envelope (POST /api/v1/events); the PDF Appendix A shape is in api/validators. */
export const eventEnvelopeSchema = z.strictObject({
  eventType: z.string().regex(/^[A-Z]{4}-\d{3}$/),
  userId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9:_|./-]+$/)
    .optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Kafka message: a reference only — the payload stays in PostgreSQL. */
export const kafkaEventSchema = z.strictObject({
  eventId: z.uuid(),
  eventType: z.string(),
  userId: z.uuid(),
  occurredAt: z.string(),
  correlationId: z.string(),
  schemaVersion: z.literal(1),
});
export type KafkaEventMessage = z.infer<typeof kafkaEventSchema>;
