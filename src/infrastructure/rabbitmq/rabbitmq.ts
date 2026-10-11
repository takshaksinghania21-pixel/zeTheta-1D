import amqp, {
  type Channel,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import { allRetryBands } from '../../modules/retries/backoff';
import { CHANNELS, type Channel as NotifyChannel } from '../../domain/types';
import type { Logger } from '../../common/logger';

export interface RabbitTopology {
  deliveryExchange: string;
  retryExchange: string;
  dlx: string;
  deliveryQueue(channel: NotifyChannel): string;
  retryQueue(band: number): string;
  dlqQueue: string;
}

export function rabbitTopology(prefix: string): RabbitTopology {
  return {
    deliveryExchange: `${prefix}delivery`,
    retryExchange: `${prefix}retry`,
    dlx: `${prefix}dlx`,
    deliveryQueue: (c) => `${prefix}delivery.${c}`,
    retryQueue: (b) => `${prefix}retry.b${b}`,
    dlqQueue: `${prefix}delivery.dlq`,
  };
}

export const MAX_PRIORITY = 10;
export const RETRY_BAND_HEADER = 'retry-band';

/**
 * Declares durable exchanges/queues (idempotent):
 *  - delivery (direct): one priority queue per channel, poison → DLX
 *  - retry (headers): one queue per delay band; expired messages dead-letter
 *    back to the delivery exchange with their original routing key (channel)
 *  - dlx (direct) → delivery.dlq for exhausted/poison messages
 */
export async function assertTopology(ch: Channel, t: RabbitTopology): Promise<void> {
  await ch.assertExchange(t.deliveryExchange, 'direct', { durable: true });
  await ch.assertExchange(t.retryExchange, 'headers', { durable: true });
  await ch.assertExchange(t.dlx, 'direct', { durable: true });
  await ch.assertQueue(t.dlqQueue, { durable: true, arguments: { 'x-queue-type': 'classic' } });
  await ch.bindQueue(t.dlqQueue, t.dlx, 'poison');
  await ch.bindQueue(t.dlqQueue, t.dlx, 'exhausted');
  for (const c of CHANNELS) {
    const q = t.deliveryQueue(c);
    await ch.assertQueue(q, {
      durable: true,
      arguments: {
        'x-queue-type': 'classic',
        'x-max-priority': MAX_PRIORITY,
        'x-dead-letter-exchange': t.dlx,
        'x-dead-letter-routing-key': 'poison',
      },
    });
    await ch.bindQueue(q, t.deliveryExchange, c);
  }
  for (const band of allRetryBands()) {
    const q = t.retryQueue(band);
    await ch.assertQueue(q, {
      durable: true,
      arguments: { 'x-queue-type': 'classic', 'x-dead-letter-exchange': t.deliveryExchange },
    });
    // NB: headers-exchange matching ignores keys starting with "x-", so the band
    // header must not use that prefix (otherwise every band queue matches).
    await ch.bindQueue(q, t.retryExchange, '', {
      'x-match': 'all',
      [RETRY_BAND_HEADER]: String(band),
    });
  }
}

export class RabbitConnection {
  private model: ChannelModel | undefined;
  private confirmChannel: ConfirmChannel | undefined;
  private closing = false;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<ChannelModel> {
    if (this.model) return this.model;
    const model = await amqp.connect(this.url, {
      clientProperties: { connection_name: 'zetheta-notify' },
    });
    model.on('error', (err: Error) => {
      this.logger.error({ err }, 'rabbitmq connection error');
    });
    model.on('close', () => {
      this.model = undefined;
      this.confirmChannel = undefined;
      if (!this.closing) this.logger.warn('rabbitmq connection closed');
    });
    this.model = model;
    return model;
  }

  async publisher(): Promise<ConfirmChannel> {
    if (this.confirmChannel) return this.confirmChannel;
    const model = await this.connect();
    const ch = await model.createConfirmChannel();
    ch.on('error', (err: Error) => {
      this.logger.error({ err }, 'rabbitmq publisher channel error');
    });
    ch.on('close', () => (this.confirmChannel = undefined));
    this.confirmChannel = ch;
    return ch;
  }

  /** Publishes and resolves only once the broker confirms persistence. */
  async publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    options: Options.Publish,
  ): Promise<void> {
    const ch = await this.publisher();
    await new Promise<void>((resolve, reject) => {
      ch.publish(
        exchange,
        routingKey,
        body,
        { persistent: true, contentType: 'application/json', ...options },
        (err) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        },
      );
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.confirmChannel?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.model?.close();
    } catch {
      /* already closed */
    }
    this.model = undefined;
  }

  get connected(): boolean {
    return this.model !== undefined;
  }
}

export type ConsumeOutcome = 'ack' | 'poison' | 'requeue';

/**
 * Consumes a queue with manual acknowledgements and a prefetch limit. The
 * handler decides the outcome only AFTER it has durably recorded the result.
 */
export async function consumeQueue(
  conn: RabbitConnection,
  queue: string,
  prefetch: number,
  handler: (msg: ConsumeMessage) => Promise<ConsumeOutcome>,
  logger: Logger,
): Promise<{ channel: Channel; cancel: () => Promise<void>; inFlight: () => number }> {
  const model = await conn.connect();
  const ch = await model.createChannel();
  await ch.prefetch(prefetch);
  let inFlight = 0;
  const { consumerTag } = await ch.consume(
    queue,
    (msg) => {
      if (!msg) return;
      inFlight++;
      handler(msg)
        .then((outcome) => {
          if (outcome === 'ack') ch.ack(msg);
          else if (outcome === 'poison') ch.nack(msg, false, false);
          else
            setTimeout(() => {
              ch.nack(msg, false, true);
            }, 1000).unref();
        })
        .catch((err: unknown) => {
          logger.error({ err, queue }, 'unhandled consumer error; requeueing after delay');
          setTimeout(() => {
            try {
              ch.nack(msg, false, true);
            } catch {
              /* channel closed: broker will redeliver */
            }
          }, 1000).unref();
        })
        .finally(() => inFlight--);
    },
    { noAck: false },
  );
  return {
    channel: ch,
    inFlight: () => inFlight,
    cancel: async () => {
      try {
        await ch.cancel(consumerTag);
      } catch {
        /* ignore */
      }
    },
  };
}

export async function queueDepths(
  conn: RabbitConnection,
  queues: string[],
): Promise<Record<string, { messages: number; consumers: number }>> {
  const model = await conn.connect();
  const ch = await model.createChannel();
  const out: Record<string, { messages: number; consumers: number }> = {};
  try {
    for (const q of queues) {
      const r = await ch.checkQueue(q);
      out[q] = { messages: r.messageCount, consumers: r.consumerCount };
    }
  } finally {
    await ch.close().catch(() => undefined);
  }
  return out;
}
