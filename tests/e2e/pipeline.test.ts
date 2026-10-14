import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { CHANNELS } from '../../src/utils/types';
import { queueDepths } from '../../src/infrastructure/rabbitmq/rabbitmq';
import { SAMPLE_PAYLOADS } from '../../src/events/models/fixtures';
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
    'critical-consumer',
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
  for (const q of [...CHANNELS.map((c) => s.c.topology.deliveryQueue(c)), s.c.topology.dlqQueue])
    await ch.deleteQueue(q).catch(() => undefined);
  for (const ex of [s.c.topology.deliveryExchange, s.c.topology.dlx])
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
    expect(ns.map((n) => n.channel).sort()).toEqual(['email', 'inapp', 'push', 'sms']);
    expect(received[0]?.title).toBe('Buy order executed: INFY');

    const inapp = ns.find((n) => n.channel === 'inapp')!;
    const read = await api().post(`/api/v1/notifications/${inapp.id}/read`).set(auth(userToken));
    expect(read.body.state).toBe('READ');
    const click = await api().post(`/api/v1/notifications/${inapp.id}/click`).set(auth(userToken));
    expect(click.body.clickedAt).not.toBeNull();
    const own = await api().get('/api/v1/notifications?unreadOnly=false').set(auth(userToken));
    expect(own.body.items.length).toBe(4);

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
    // Real-time Redis counters (Day 10) and the per-user engagement feature store (§A3.2 P3).
    const realtime = await waitFor(
      async () =>
        (await api().get('/api/v1/analytics/realtime?minutes=10').set(auth(operator))).body
          .byChannel as Record<string, { delivered?: number }>,
      (rt) => (rt.push?.delivered ?? 0) >= 1 && (rt.inapp?.delivered ?? 0) >= 1,
      30000,
    );
    expect(realtime.push?.delivered).toBeGreaterThanOrEqual(1);
    expect((await s.c.features().engagement(userId)).inapp?.engaged).toBeGreaterThanOrEqual(1);
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
    // Failures from earlier tests are still inside the breaker's 60 s window.
    await api()
      .patch('/api/v1/ops/providers/mock-email')
      .set(auth(admin))
      .send({ resetCircuit: true });
    await api()
      .post('/api/v1/ops/providers/mock-email/simulate')
      .set(auth(admin))
      .send({ mode: 'fail_transient', remaining: null });
    const eventId = await submit(userId, 'TXNX-004', SAMPLE_PAYLOADS['TXNX-004']!); // MEDIUM: 3 retries (fast test policy)
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
        x.length === 4 &&
        x.every((n) => n.state === (n.channel === 'inapp' ? 'SENT' : 'DELIVERED')),
      30000,
    );
    expect(ns).toHaveLength(4);
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

// The same compliance flows were checked against the Docker Compose deployment
// (reports/docker-functional.json); here they run on the e2e stack with mock providers.
describe('compliance and delivery flows (all workers, mock providers)', () => {
  type Decision = { rule: string; channel: string | null; outcome: string };
  const eventStatus = async (eventId: string) =>
    (await api().get(`/api/v1/events/${eventId}`).set(auth(operator))).body as {
      status: string;
      notifications: { id: string; channel: string; state: string }[];
      decisions: Decision[];
    };
  const processed = (eventId: string) =>
    waitFor(
      () => eventStatus(eventId),
      (e) => e.status === 'PROCESSED',
      30000,
    );
  const stateOf = (e: { notifications: { channel: string; state: string }[] }, ch: string) =>
    e.notifications.find((n) => n.channel === ch)?.state;
  const has = (e: { decisions: Decision[] }, ch: string, rule: string, outcome: string) =>
    e.decisions.some((d) => d.channel === ch && d.rule === rule && d.outcome === outcome);
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  const uniquePhone = () =>
    `+9198${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
  let quietUser = '';

  it('quiet hours defer push and SMS; in-app is delivered', async () => {
    quietUser = await createUser(s.c);
    const now = Date.now();
    // A 7-hour window around "now" in UTC (minimum is 6 h), so the test is time-independent.
    const q = await api()
      .put(`/api/v1/users/${quietUser}/preferences/quiet-hours`)
      .set(auth(service))
      .send({
        enabled: true,
        start: hhmm(new Date(now - 3600_000)),
        end: hhmm(new Date(now + 6 * 3600_000)),
        timezone: 'UTC',
      });
    expect(q.status).toBe(200);
    const e = await processed(await submit(quietUser, 'TXNX-005', SAMPLE_PAYLOADS['TXNX-005']!));
    expect(stateOf(e, 'push')).toBe('QUIET');
    expect(stateOf(e, 'sms')).toBe('QUIET');
    expect(stateOf(e, 'inapp')).toBe('SENT');
    expect(has(e, 'push', 'QUIET_HOURS_DEFER', 'DEFER')).toBe(true);
    expect(has(e, 'sms', 'QUIET_HOURS_DEFER', 'DEFER')).toBe(true);
  });

  it('a CRITICAL margin call bypasses quiet hours and the bypass is recorded', async () => {
    const eventId = await submit(quietUser, 'RISK-001', SAMPLE_PAYLOADS['RISK-001']!);
    const e = await waitFor(
      () => eventStatus(eventId),
      (x) =>
        x.status === 'PROCESSED' &&
        ['sms', 'push'].every((ch) => ['SENT', 'DELIVERED'].includes(stateOf(x, ch) ?? '')),
      30000,
    );
    expect(has(e, 'sms', 'QUIET_HOURS_BYPASS', 'BYPASS')).toBe(true);
    expect(has(e, 'push', 'QUIET_HOURS_BYPASS', 'BYPASS')).toBe(true);
    // The audit record is the persisted policy decision, with its check time.
    const stored = await s.c
      .db()('policy_decisions')
      .where({ event_id: eventId, rule: 'QUIET_HOURS_BYPASS' })
      .select('channel', 'outcome', 'created_at');
    expect(stored.map((d: { channel: string }) => d.channel).sort()).toEqual(['push', 'sms']);
  });

  let dndUser = '';
  it('DND blocks promotional SMS to a FULLY_BLOCKED number', async () => {
    const phone = uniquePhone();
    dndUser = await createUser(s.c, {
      contacts: [
        { channel: 'sms', value: phone },
        { channel: 'email', value: `dnd-${Date.now()}@example.test` },
        { channel: 'push', value: `fcm-token-dnd-${Date.now()}-0000000000` },
      ],
    });
    const imp = await api()
      .post('/api/v1/compliance/dnd/imports')
      .set(auth(admin))
      .send({
        source: 'e2e-synthetic',
        registrySnapshotAt: new Date().toISOString(),
        entries: [{ phone, status: 'FULLY_BLOCKED', blockedCategories: [] }],
      });
    expect(imp.status).toBe(201);
    const consent = await api()
      .post(`/api/v1/users/${dndUser}/consents`)
      .set(auth(service))
      .send({ channel: 'sms', purpose: 'PROMOTIONAL', status: 'GRANTED', source: 'API' });
    expect(consent.status).toBe(201);
    // SMS as the only intrusive channel, so cost optimisation cannot drop it before the DND check.
    const prefs = await api()
      .put(`/api/v1/users/${dndUser}/preferences/categories`)
      .set(auth(service))
      .send({ SIP: { enabled: true, channels: ['sms', 'inapp'] } });
    expect(prefs.status).toBe(200);
    const e = await processed(await submit(dndUser, 'SIPX-004', SAMPLE_PAYLOADS['SIPX-004']!));
    expect(stateOf(e, 'sms')).toBe('DND');
    expect(has(e, 'sms', 'CONSENT_EXPLICIT', 'ALLOW')).toBe(true);
    expect(has(e, 'sms', 'DND_FULLY_BLOCKED', 'BLOCK')).toBe(true);
  });

  it('a mandatory margin call still reaches the DND-registered number by SMS', async () => {
    const eventId = await submit(dndUser, 'RISK-001', SAMPLE_PAYLOADS['RISK-001']!);
    const e = await waitFor(
      () => eventStatus(eventId),
      (x) => x.status === 'PROCESSED' && ['SENT', 'DELIVERED'].includes(stateOf(x, 'sms') ?? ''),
      30000,
    );
    expect(has(e, 'sms', 'DND_NOT_APPLICABLE', 'ALLOW')).toBe(true);
  });

  it('caps the 4th MARKET alert within an hour (3 per category per hour)', async () => {
    const userId = await createUser(s.c);
    const ids: string[] = [];
    for (const [i, symbol] of ['SBIN', 'TCS', 'HDFCBANK', 'WIPRO'].entries()) {
      const id = await submit(userId, 'MKTX-001', {
        ...SAMPLE_PAYLOADS['MKTX-001'],
        alertId: `PA-E2E-${i}`,
        symbol,
        triggeredAt: new Date().toISOString(),
      });
      ids.push(id);
      await processed(id); // sequential, so the cap order is deterministic
    }
    const first = await eventStatus(ids[0]!);
    const fourth = await eventStatus(ids[3]!);
    expect(stateOf(first, 'push')).not.toBe('CAPPED');
    expect(stateOf(fourth, 'push')).toBe('CAPPED');
    expect(stateOf(fourth, 'inapp')).toBe('SENT'); // in-app is never capped
    expect(has(fourth, 'push', 'FREQUENCY_CAP_CATEGORY', 'CAP')).toBe(true);
  });

  it('schedules a transient failure in the Redis retry ZSET, then delivers', async () => {
    const userId = await createUser(s.c);
    const redis = s.c.redis();
    const key = `${s.config.RABBITMQ_PREFIX}retry:schedule`;
    const zadd = jest.spyOn(redis, 'zadd'); // records the call; Redis still receives it
    try {
      await api()
        .post('/api/v1/ops/providers/mock-push/simulate')
        .set(auth(admin))
        .send({ mode: 'fail_transient', remaining: 1 })
        .expect(200);
      const eventId = await submit(userId, 'TXNX-005', SAMPLE_PAYLOADS['TXNX-005']!);
      const ns = await waitFor(
        () => notificationsOf(eventId),
        (x) => x.find((n) => n.channel === 'push')?.state === 'DELIVERED',
        30000,
      );
      const push = ns.find((n) => n.channel === 'push')!;
      const call = zadd.mock.calls.find(
        (c) => c[0] === key && (c[2] as string).includes(push.id),
      ) as unknown as [string, number, string] | undefined;
      expect(call).toBeDefined();
      expect(JSON.parse(call![2])).toMatchObject({ id: push.id, channel: 'push', retry: 1 });
      expect(call![1]).toBeGreaterThan(Date.now() - 60_000); // score = due time (epoch ms)
      const history = (
        await api().get(`/api/v1/notifications/${push.id}/history`).set(auth(operator))
      ).body.items as { toState: string }[];
      expect(history.map((h) => h.toState)).toEqual(
        expect.arrayContaining(['RETRYING', 'SENT', 'DELIVERED']),
      );
      // Released members are removed from the set.
      const left = await redis.zrange(key, 0, -1);
      expect(left.some((m) => m.includes(push.id))).toBe(false);
    } finally {
      zadd.mockRestore();
    }
  });

  it('analytics reflect these flows consistently (Redis counters and delivery rates)', async () => {
    const rt = await waitFor(
      async () =>
        (await api().get('/api/v1/analytics/realtime?minutes=30').set(auth(operator))).body
          .byChannel as Record<string, Record<string, number>>,
      (b) => (b.sms?.dnd ?? 0) >= 1 && (b.push?.capped ?? 0) >= 1,
      30000,
    );
    expect(rt.push!.delivered).toBeGreaterThanOrEqual(1);
    type Rates = {
      summary: { total_sent: number; total_delivered: number; overall_delivery_rate: number };
      by_channel: Record<string, { sent: number; delivered: number; rate: number | null }>;
      frequency_cap_hits: { total: number };
      dnd_blocks: { total: number; promotional_blocked: number };
    };
    const r = await waitFor(
      async () =>
        (await api().get('/api/v1/analytics/delivery-rates?period=24h').set(auth(operator)))
          .body as Rates,
      (b) => b.dnd_blocks.promotional_blocked >= 1 && b.frequency_cap_hits.total >= 1,
      30000,
    );
    const channels = Object.values(r.by_channel);
    expect(channels.reduce((t, c) => t + c.delivered, 0)).toBe(r.summary.total_delivered);
    expect(channels.reduce((t, c) => t + c.sent, 0)).toBe(r.summary.total_sent);
    for (const c of channels) {
      expect(c.delivered).toBeLessThanOrEqual(c.sent);
      if (c.rate !== null) expect(c.rate).toBeCloseTo(c.delivered / c.sent, 3);
    }
    expect(r.summary.overall_delivery_rate).toBeCloseTo(
      r.summary.total_delivered / r.summary.total_sent,
      3,
    );
  });
});
