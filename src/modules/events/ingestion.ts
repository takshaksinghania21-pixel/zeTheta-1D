import type { Knex } from 'knex';
import { z } from 'zod';
import { sha256Hex, stableStringify } from '../../common/crypto';
import { AppError, ConflictError, ValidationError } from '../../common/errors';
import { metrics } from '../../common/metrics';
import { enqueueOutbox } from '../../infrastructure/outbox/outbox';
import type { EventTaxonomy } from '../taxonomy/taxonomy';

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

export interface IngestResult {
  status: 'ACCEPTED' | 'DUPLICATE';
  eventId: string;
  idempotencyKey: string;
}

export interface FinancialEventRow {
  id: string;
  event_type: string;
  category: string;
  user_id: string;
  source: string;
  idempotency_key: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  received_at: Date;
  status: 'RECEIVED' | 'PUBLISHED' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
  status_reason: string | null;
  batch_id: string | null;
  correlation_id: string;
  processed_at: Date | null;
}

export class EventIngestionService {
  constructor(
    private readonly db: Knex,
    private readonly taxonomy: EventTaxonomy,
    private readonly topic: string,
  ) {}

  /** Validates against the taxonomy; throws 422 with field-level details. */
  validate(envelope: EventEnvelope): {
    payload: Record<string, unknown>;
    category: string;
    idempotencyKey: string;
  } {
    const def = this.taxonomy.get(envelope.eventType);
    if (!def) {
      throw new ValidationError(
        `Unknown event type '${envelope.eventType}'`,
        [{ path: 'eventType', message: 'not registered in taxonomy' }],
        'UNKNOWN_EVENT_TYPE',
      );
    }
    const res = this.taxonomy.validatePayload(envelope.eventType, envelope.payload);
    if (!res.ok)
      throw new ValidationError(
        `Payload does not match schema for ${envelope.eventType}`,
        res.errors,
        'EVENT_SCHEMA_INVALID',
      );
    const idempotencyKey =
      envelope.idempotencyKey ??
      this.taxonomy.deriveIdempotencyKey(envelope.eventType, envelope.userId, res.payload);
    return { payload: res.payload, category: def.category, idempotencyKey };
  }

  async ingest(
    envelope: EventEnvelope,
    source: string,
    correlationId: string,
    batchId: string | null = null,
  ): Promise<IngestResult> {
    const { payload, category, idempotencyKey } = this.validate(envelope);
    const payloadHash = sha256Hex(
      stableStringify({
        eventType: envelope.eventType,
        userId: envelope.userId,
        occurredAt: new Date(envelope.occurredAt).toISOString(),
        payload,
      }),
    );
    try {
      return await this.db.transaction(async (trx) => {
        const user = (await trx('users').where({ id: envelope.userId }).first('status')) as
          | { status: string }
          | undefined;
        if (!user)
          throw new ValidationError(
            'Unknown user',
            [{ path: 'userId', message: 'user does not exist' }],
            'EVENT_SCHEMA_INVALID',
          );
        const inserted = (await trx('financial_events')
          .insert({
            event_type: envelope.eventType,
            category,
            user_id: envelope.userId,
            source,
            idempotency_key: idempotencyKey,
            payload_hash: payloadHash,
            payload: JSON.stringify(payload),
            occurred_at: envelope.occurredAt,
            correlation_id: correlationId,
            batch_id: batchId,
          })
          .onConflict(['source', 'idempotency_key'])
          .ignore()
          .returning('id')) as { id: string }[];
        const id = inserted[0]?.id;
        if (!id)
          return this.resolveDuplicate(
            trx,
            source,
            idempotencyKey,
            payloadHash,
            envelope.eventType,
          );
        const message: KafkaEventMessage = {
          eventId: id,
          eventType: envelope.eventType,
          userId: envelope.userId,
          occurredAt: envelope.occurredAt,
          correlationId,
          schemaVersion: 1,
        };
        await enqueueOutbox(trx, [
          {
            destination: 'KAFKA',
            topic: this.topic,
            key: envelope.userId,
            payload: message,
            headers: { 'x-correlation-id': correlationId, 'x-event-type': envelope.eventType },
          },
        ]);
        metrics.eventsIngested.inc({ event_type: envelope.eventType, outcome: 'accepted' });
        return { status: 'ACCEPTED' as const, eventId: id, idempotencyKey };
      });
    } catch (err) {
      if (err instanceof AppError)
        metrics.eventsIngested.inc({
          event_type: envelope.eventType,
          outcome: err.code.toLowerCase(),
        });
      throw err;
    }
  }

  private async resolveDuplicate(
    trx: Knex.Transaction,
    source: string,
    key: string,
    hash: string,
    eventType: string,
  ): Promise<IngestResult> {
    const existing = (await trx('financial_events')
      .where({ source, idempotency_key: key })
      .first('id', 'payload_hash')) as { id: string; payload_hash: string } | undefined;
    if (!existing) throw new ConflictError('Concurrent ingestion conflict; retry');
    if (existing.payload_hash !== hash) {
      metrics.eventsIngested.inc({ event_type: eventType, outcome: 'idempotency_conflict' });
      throw new ConflictError(
        `Idempotency key '${key}' was already used with a different payload`,
        'IDEMPOTENCY_CONFLICT',
      );
    }
    metrics.eventsIngested.inc({ event_type: eventType, outcome: 'duplicate' });
    return { status: 'DUPLICATE', eventId: existing.id, idempotencyKey: key };
  }

  async ingestBatch(
    envelopes: unknown[],
    source: string,
    correlationId: string,
    submittedBy: string,
  ): Promise<{ batchId: string; results: BatchItemResult[] }> {
    const [batch] = (await this.db('ingestion_batches')
      .insert({
        submitted_by: submittedBy,
        total: envelopes.length,
        accepted: 0,
        duplicates: 0,
        rejected: 0,
      })
      .returning('id')) as { id: string }[];
    if (!batch) throw new Error('batch insert failed');
    const results: BatchItemResult[] = [];
    for (const [index, raw] of envelopes.entries()) {
      const parsed = eventEnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        results.push({
          index,
          status: 'REJECTED',
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid event envelope',
            details: parsed.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        });
        continue;
      }
      try {
        const r = await this.ingest(parsed.data, source, `${correlationId}:${index}`, batch.id);
        results.push({ index, status: r.status, eventId: r.eventId });
      } catch (err) {
        if (err instanceof AppError && err.expose) {
          results.push({
            index,
            status: 'REJECTED',
            error: { code: err.code, message: err.message, details: err.details },
          });
        } else throw err;
      }
    }
    await this.db('ingestion_batches')
      .where({ id: batch.id })
      .update({
        accepted: results.filter((r) => r.status === 'ACCEPTED').length,
        duplicates: results.filter((r) => r.status === 'DUPLICATE').length,
        rejected: results.filter((r) => r.status === 'REJECTED').length,
      });
    return { batchId: batch.id, results };
  }

  async getEvent(id: string): Promise<FinancialEventRow | undefined> {
    return (await this.db('financial_events').where({ id }).first()) as
      | FinancialEventRow
      | undefined;
  }

  async getBatch(
    id: string,
  ): Promise<{ batch: Record<string, unknown>; statusCounts: Record<string, number> } | undefined> {
    const batch = (await this.db('ingestion_batches').where({ id }).first()) as
      | Record<string, unknown>
      | undefined;
    if (!batch) return undefined;
    const rows = (await this.db('financial_events')
      .where({ batch_id: id })
      .groupBy('status')
      .select('status')
      .count('* as n')) as { status: string; n: string }[];
    return { batch, statusCounts: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) };
  }
}

export interface BatchItemResult {
  index: number;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  eventId?: string;
  error?: { code: string; message: string; details?: unknown };
}
