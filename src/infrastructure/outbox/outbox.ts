import type { Knex } from 'knex';
import type { Producer } from 'kafkajs';
import type { Logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import type { RabbitConnection } from '../rabbitmq/rabbitmq';

export interface KafkaOutboxMessage {
  destination: 'KAFKA';
  topic: string;
  key: string;
  payload: unknown;
  headers?: Record<string, string>;
}

export interface RabbitOutboxMessage {
  destination: 'RABBITMQ';
  exchange: string;
  routingKey: string;
  payload: unknown;
  headers?: Record<string, string>;
  priority?: number;
  messageId?: string;
}

export type OutboxMessage = KafkaOutboxMessage | RabbitOutboxMessage;

/** Inserts outbox rows inside the caller's transaction. */
export async function enqueueOutbox(
  trx: Knex | Knex.Transaction,
  messages: OutboxMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  await trx('outbox').insert(
    messages.map((m) =>
      m.destination === 'KAFKA'
        ? {
            destination: 'KAFKA',
            target: m.topic,
            message_key: m.key,
            payload: JSON.stringify(m.payload),
            headers: JSON.stringify(m.headers ?? {}),
          }
        : {
            destination: 'RABBITMQ',
            target: m.exchange,
            routing_key: m.routingKey,
            message_key: m.messageId ?? null,
            payload: JSON.stringify(m.payload),
            headers: JSON.stringify(m.headers ?? {}),
            priority: m.priority ?? null,
          },
    ),
  );
}

interface OutboxRow {
  id: number;
  destination: 'KAFKA' | 'RABBITMQ';
  target: string;
  routing_key: string | null;
  message_key: string | null;
  payload: unknown;
  headers: Record<string, string>;
  priority: number | null;
  attempts: number;
}

/**
 * Polls the outbox and publishes rows (at-least-once). Rows are claimed with
 * FOR UPDATE SKIP LOCKED so several relays can run concurrently; a row is
 * marked published only after Kafka acks / RabbitMQ confirms it.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;
  private wake: (() => void) | undefined;

  constructor(
    private readonly db: Knex,
    private readonly producer: Producer | null,
    private readonly rabbit: RabbitConnection | null,
    private readonly logger: Logger,
    private readonly options: { pollMs: number; batchSize: number },
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  /** Triggers an immediate poll (used after local commits). */
  kick(): void {
    this.wake?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((r) => setTimeout(r, 20));
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      let published = 0;
      try {
        published = await this.publishBatch();
      } catch (err) {
        this.logger.error({ err }, 'outbox relay batch failed');
      }
      if (published < this.options.batchSize && !this.isStopped()) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.timer = setTimeout(resolve, this.options.pollMs);
        });
        this.wake = undefined;
      }
    }
  }

  /** Publishes one batch; returns the number of rows published. */
  async publishBatch(): Promise<number> {
    this.running = true;
    try {
      return await this.db.transaction(async (trx) => {
        const rows = (await trx('outbox')
          .whereNull('published_at')
          .andWhere('available_at', '<=', trx.fn.now())
          .orderBy('id')
          .limit(this.options.batchSize)
          .forUpdate()
          .skipLocked()
          .select('*')) as OutboxRow[];
        if (rows.length === 0) return 0;
        const ok: number[] = [];
        const failed: { id: number; error: string }[] = [];

        const kafkaRows = rows.filter((r) => r.destination === 'KAFKA');
        if (kafkaRows.length > 0) {
          try {
            if (!this.producer) throw new Error('Kafka producer not configured');
            const byTopic = new Map<string, OutboxRow[]>();
            for (const r of kafkaRows) byTopic.set(r.target, [...(byTopic.get(r.target) ?? []), r]);
            await this.producer.sendBatch({
              acks: -1,
              topicMessages: [...byTopic.entries()].map(([topic, rs]) => ({
                topic,
                messages: rs.map((r) => ({
                  key: r.message_key,
                  value: JSON.stringify(r.payload),
                  headers: r.headers,
                })),
              })),
            });
            ok.push(...kafkaRows.map((r) => r.id));
          } catch (err) {
            failed.push(...kafkaRows.map((r) => ({ id: r.id, error: (err as Error).message })));
          }
        }
        for (const r of rows.filter((x) => x.destination === 'RABBITMQ')) {
          try {
            if (!this.rabbit) throw new Error('RabbitMQ not configured');
            await this.rabbit.publish(
              r.target,
              r.routing_key ?? '',
              Buffer.from(JSON.stringify(r.payload)),
              {
                headers: r.headers,
                ...(r.priority !== null ? { priority: r.priority } : {}),
                ...(r.message_key ? { messageId: r.message_key } : {}),
                ...(r.headers['x-correlation-id']
                  ? { correlationId: r.headers['x-correlation-id'] }
                  : {}),
              },
            );
            ok.push(r.id);
          } catch (err) {
            failed.push({ id: r.id, error: (err as Error).message });
          }
        }
        if (ok.length > 0)
          await trx('outbox').whereIn('id', ok).update({ published_at: trx.fn.now() });
        for (const f of failed) {
          const row = rows.find((r) => r.id === f.id);
          const backoffMs = Math.min(30000, 250 * 2 ** Math.min(row?.attempts ?? 0, 7));
          await trx('outbox')
            .where('id', f.id)
            .update({
              attempts: trx.raw('attempts + 1'),
              last_error: f.error.slice(0, 500),
              available_at: trx.raw(`now() + interval '${backoffMs} milliseconds'`),
            });
        }
        if (failed.length > 0)
          this.logger.warn(
            { failed: failed.length, error: failed[0]?.error },
            'outbox publish failures; will retry',
          );
        return ok.length;
      });
    } finally {
      this.running = false;
    }
  }

  async backlog(): Promise<number> {
    const row = (await this.db('outbox')
      .whereNull('published_at')
      .count<{ count: string }[]>('* as count')
      .first()) ?? { count: '0' };
    const n = Number(row.count);
    metrics.outboxBacklog.set(n);
    return n;
  }
}
