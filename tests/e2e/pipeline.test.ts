import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { CHANNELS } from '../../src/domain/types';
import { queueDepths } from '../../src/infrastructure/rabbitmq/rabbitmq';
import { SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import { startWorkers, stopWorkers } from '../../src/workers/main';
import { startDispatcher, startOutboxRelay, type RunningWorker } from '../../src/workers/workers';
import {
  createUser,
  freePort,
  principalToken,
  startStack,
  waitFor,
  type Stack,
} from '../helpers/stack';

jest.setTimeout(90000);

let s: Stack;
let workers: RunningWorker[] = [];
let service: string;
let operator: string;
let admin: string;

type N = {
  id: string;
  channel: string;
  state: string;
  provider: string | null;
  retryCount: number;
};

beforeAll(async () => {
  const port = await freePort();
  s = await startStack(
    {
      MOCK_RECEIPT_CALLBACK_URL: `http://127.0.0.1:${port}/api/v1/webhooks/mock`,
      MOCK_RECEIPT_DELAY_MS: '50',
    },
    {},
    port,
  );
  workers = await startWorkers(s.c, [
    'outbox-relay',
    'event-consumer',
    'dispatcher',
    'dlq-ingest',
    'scheduler',
    'analytics',
  ]);
  service = await principalToken(s.c, ['SERVICE']);
  operator = await principalToken(s.c, ['OPERATOR']);
  admin = await principalToken(s.c, ['ADMIN']);
});

afterAll(async () => {
  await stopWorkers(s.c, workers);
  const admin = s.c.kafka().admin();
  await admin.connect();
  await admin.deleteTopics({ topics: Object.values(s.c.topics) }).catch(() => undefined);
  await admin.disconnect();
  const ch = await (await s.c.rabbit().connect()).createChannel();
  for (const q of [
    ...CHANNELS.map((c) => s.c.topology.deliveryQueue(c)),
    s.c.topology.dlqQueue,
    ...Array.from({ length: 15 }, (_, i) => s.c.topology.retryQueue(i + 9)),
  ])
    await ch.deleteQueue(q).catch(() => undefined);
  for (const ex of [s.c.topology.deliveryExchange, s.c.topology.retryExchange, s.c.topology.dlx])
    await ch.deleteExchange(ex).catch(() => undefined);
  await ch.close().catch(() => undefined);
  await s.close();
});

const api = () => request(s.server);
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function submit(
  userId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const r = await api()
    .post('/api/v1/events')
    .set(auth(service))
    .send({ eventType, userId, occurredAt: new Date().toISOString(), payload });
  expect(r.status).toBe(202);
  return r.body.eventId as string;
}

async function notificationsOf(eventId: string): Promise<N[]> {
  return (await api().get(`/api/v1/notifications?eventId=${eventId}&limit=50`).set(auth(operator)))
    .body.items as N[];
}

const settled = (states: string[]) => (ns: N[]) =>
  ns.length > 0 && ns.every((n) => states.includes(n.state));

describe('end-to-end notification pipeline', () => {
  it('ingest → Kafka → routing → RabbitMQ → providers → receipts → Socket.IO → analytics', async () => {
    const userId = await createUser(s.c);
    const userToken = (await s.c.auth().mintUserToken(userId)).accessToken;
    const socket: Socket = ioClient(s.baseUrl, {
      auth: { token: userToken },
      transports: ['websocket'],
    });
    const received: { id: string; title: string }[] = [];
    socket.on('notification', (n: { id: string; title: string }) => {
      received.push(n);
      socket.emit('notification:ack', { id: n.id });
    });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });

    const eventId = await submit(userId, 'TXNX-001', SAMPLE_PAYLOADS['TXNX-001']!);
    const ns = await waitFor(() => notificationsOf(eventId), settled(['DELIVERED']), 30000);
    expect(ns.map((n) => n.channel).sort()).toEqual(['email', 'inapp', 'push']);
    expect(received[0]?.title).toBe('Buy order executed: INFY');

    const inapp = ns.find((n) => n.channel === 'inapp')!;
    const read = await api().post(`/api/v1/notifications/${inapp.id}/read`).set(auth(userToken));
    expect(read.body.state).toBe('READ');
    const click = await api().post(`/api/v1/notifications/${inapp.id}/click`).set(auth(userToken));
    expect(click.body.clickedAt).not.toBeNull();
    const own = await api().get('/api/v1/notifications?unreadOnly=false').set(auth(userToken));
    expect(own.body.items.length).toBe(3);

    const history = await api()
      .get(`/api/v1/notifications/${inapp.id}/history`)
      .set(auth(operator));
    expect(history.body.items.map((h: { toState: string }) => h.toState)).toEqual([
      'CREATED',
      'ENRICHED',
      'ROUTED',
      'QUEUED',
      'SENT',
      'DELIVERED',
      'READ',
    ]);

    // Analytics lag target: aggregates reflect the run well within 30 s.
    const started = Date.now();
    const analytics = await waitFor(
      async () =>
        (await api().get('/api/v1/analytics/delivery').set(auth(operator))).body.data as {
          channel: string;
          delivered: number;
        }[],
      (rows) =>
        ['push', 'email', 'inapp'].every(
          (ch) => (rows.find((r) => r.channel === ch)?.delivered ?? 0) >= 1,
        ),
      30000,
      250,
    );
    expect(Date.now() - started).toBeLessThan(30000);
    expect(analytics.length).toBeGreaterThan(0);
    const eng = await waitFor(
      async () =>
        (await api().get('/api/v1/analytics/engagement').set(auth(operator))).body.data as {
          channel: string;
          read: number | null;
          clicked: number | null;
        }[],
      (rows) => (rows.find((r) => r.channel === 'inapp')?.clicked ?? 0) >= 1,
      30000,
    );
    expect(eng.find((r) => r.channel === 'inapp')?.read).toBeGreaterThanOrEqual(1);
    expect(eng.find((r) => r.channel === 'email')?.read).toBeNull(); // not measurable, never invented
    const latency = (await api().get('/api/v1/analytics/latency').set(auth(operator))).body
      .data as { channel: string; sendLatencyMs: { p50: number; p99: number } }[];
    expect(latency.find((l) => l.channel === 'push')?.sendLatencyMs.p50).toBeGreaterThan(0);
    socket.disconnect();
  });

  it('edge 1 (e2e): a mandatory margin call reaches SMS although the user disabled SMS', async () => {
    const userId = await createUser(s.c);
    await api()
      .put(`/api/v1/users/${userId}/preferences/channels`)
      .set(auth(service))
      .send({ sms: false });
    const eventId = await submit(userId, 'RISK-001', SAMPLE_PAYLOADS['RISK-001']!);
    const ns = await waitFor(
      () => notificationsOf(eventId),
      (x) => x.find((n) => n.channel === 'sms')?.state === 'DELIVERED',
      30000,
    );
    expect(ns.find((n) => n.channel === 'sms')).toBeDefined();
    const decisions = (
      await api().get(`/api/v1/compliance/decisions?eventId=${eventId}`).set(auth(operator))
    ).body.items as { rule: string; channel: string }[];
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'REGULATORY_MANDATORY_CHANNEL', channel: 'sms' }),
      ]),
    );
  });

  it('edge 5 (e2e): fails over to the secondary SMS provider when the primary is down', async () => {
    const userId = await createUser(s.c);
    await api()
      .post('/api/v1/ops/providers/mock-sms-primary/simulate')
      .set(auth(admin))
      .send({ mode: 'fail_transient', remaining: null });
    const eventId = await submit(userId, 'TXNX-003', SAMPLE_PAYLOADS['TXNX-003']!);
    const ns = await waitFor(
      () => notificationsOf(eventId),
      (x) => x.find((n) => n.channel === 'sms')?.state === 'DELIVERED',
      30000,
    );
    expect(ns.find((n) => n.channel === 'sms')?.provider).toBe('mock-sms-secondary');
    await api()
      .post('/api/v1/ops/providers/mock-sms-primary/simulate')
      .set(auth(admin))
      .send({ mode: 'ok' });
    await api()
      .patch('/api/v1/ops/providers/mock-sms-primary')
      .set(auth(admin))
      .send({ resetCircuit: true });
  });

  it('edge 18/19 (e2e): exhausts retries into the DLQ, then an operator retry delivers it', async () => {
    const userId = await createUser(s.c);
    await api()
      .post('/api/v1/ops/providers/mock-email/simulate')
      .set(auth(admin))
      .send({ mode: 'fail_transient', remaining: null });
    const eventId = await submit(userId, 'SIPX-002', SAMPLE_PAYLOADS['SIPX-002']!); // MEDIUM: 3 retries (fast test policy)
    const ns = await waitFor(
      () => notificationsOf(eventId),
      (x) => x.find((n) => n.channel === 'email')?.state === 'DLQ',
      30000,
    );
    const email = ns.find((n) => n.channel === 'email')!;
    expect(email.retryCount).toBe(3);
    const entries = (await api().get('/api/v1/dlq?status=OPEN&channel=email').set(auth(operator)))
      .body.items as { id: string; notificationId: string }[];
    const entry = entries.find((e) => e.notificationId === email.id)!;
    await api()
      .post('/api/v1/ops/providers/mock-email/simulate')
      .set(auth(admin))
      .send({ mode: 'ok' });
    await api()
      .patch('/api/v1/ops/providers/mock-email')
      .set(auth(admin))
      .send({ resetCircuit: true });
    expect(
      (
        await api()
          .post(`/api/v1/dlq/${entry.id}/retry`)
          .set(auth(operator))
          .send({ note: 'recovered' })
      ).status,
    ).toBe(200);
    await waitFor(
      () => notificationsOf(eventId),
      (x) => x.find((n) => n.channel === 'email')?.state === 'DELIVERED',
      30000,
    );
    const detail = (await api().get(`/api/v1/dlq/${entry.id}`).set(auth(operator))).body as {
      status: string;
      deliveryAttempts: unknown[];
    };
    expect(detail.status).toBe('RETRIED');
    expect(detail.deliveryAttempts.length).toBeGreaterThanOrEqual(5);
  });

  it('edge 8 (e2e): messages survive a dispatcher crash/restart and an outbox relay outage', async () => {
    const userId = await createUser(s.c);
    const dispatcher = workers.find((w) => w.name === 'dispatcher')!;
    const relay = workers.find((w) => w.name === 'outbox-relay')!;
    await dispatcher.stop();
    await relay.stop();
    workers = workers.filter((w) => w !== dispatcher && w !== relay);

    const eventId = await submit(userId, 'TXNX-001', {
      ...SAMPLE_PAYLOADS['TXNX-001'],
      orderId: 'CRASH-1',
    });
    await new Promise((r) => setTimeout(r, 500));
    expect((await api().get(`/api/v1/events/${eventId}`).set(auth(operator))).body.status).toBe(
      'RECEIVED',
    ); // waiting in the outbox
    const backlog = await s.c.db()('outbox').whereNull('published_at').count({ n: '*' });
    expect(Number((backlog[0] as { n: string }).n)).toBeGreaterThan(0);

    const newRelay = await startOutboxRelay(s.c);
    workers.push(newRelay);
    await waitFor(() => notificationsOf(eventId), settled(['QUEUED']), 30000);
    const depths = await queueDepths(s.c.rabbit(), [s.c.topology.deliveryQueue('push')]);
    expect(depths[s.c.topology.deliveryQueue('push')]?.messages).toBeGreaterThanOrEqual(1); // durable in RabbitMQ

    workers.push(await startDispatcher(s.c));
    // No socket client is connected, so in-app stays SENT (persisted for later
    // retrieval): DELIVERED requires a client acknowledgement.
    const ns = await waitFor(
      () => notificationsOf(eventId),
      (x) =>
        x.length === 3 &&
        x.every((n) => n.state === (n.channel === 'inapp' ? 'SENT' : 'DELIVERED')),
      30000,
    );
    expect(ns).toHaveLength(3);
  });

  it('edge 6 (e2e): duplicate event ingestion yields one set of notifications', async () => {
    const userId = await createUser(s.c);
    const body = {
      eventType: 'TXNX-005',
      userId,
      occurredAt: '2026-01-15T12:30:00+05:30',
      payload: SAMPLE_PAYLOADS['TXNX-005'],
    };
    const [a, b] = await Promise.all([
      api().post('/api/v1/events').set(auth(service)).send(body),
      api().post('/api/v1/events').set(auth(service)).send(body),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 202]);
    expect(a.body.eventId).toBe(b.body.eventId);
    const ns = await waitFor(
      () => notificationsOf(a.body.eventId as string),
      settled(['SENT', 'DELIVERED']),
      30000,
    );
    expect(ns).toHaveLength(3);
  });
});
