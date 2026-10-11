import { randomUUID } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import type { LifecycleEvent } from '../../src/modules/notifications/types';
import { startStack, createUser, type Stack } from '../helpers/stack';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(() => s.close());

const ev = (
  to: LifecycleEvent['to'],
  channel: LifecycleEvent['channel'],
  extra: Partial<LifecycleEvent> = {},
): LifecycleEvent => ({
  kind: 'TRANSITION',
  transitionId: randomUUID(),
  notificationId: randomUUID(),
  eventId: null,
  userId: randomUUID(),
  eventType: 'TXNX-001',
  category: 'TRANSACTION',
  channel,
  priority: 'HIGH',
  from: null,
  to,
  at: new Date().toISOString(),
  sinceCreatedMs: 10,
  correlationId: 'c-analytics-1',
  ...extra,
});

describe('analytics aggregation', () => {
  it('counts each lifecycle transition exactly once despite Kafka redelivery', async () => {
    const sent = ev('SENT', 'sms', { costMicros: 180000 });
    expect(await s.c.analytics().ingest(sent)).toBe(true);
    expect(await s.c.analytics().ingest(sent)).toBe(false); // redelivered
    for (const e of [
      ev('QUEUED', 'sms'),
      ev('QUEUED', 'sms'),
      ev('DELIVERED', 'sms'),
      ev('FAILED', 'sms'),
      ev('CAPPED', 'push'),
      ev('QUEUED', 'push'),
      ev('READ', 'inapp'),
      ev('DELIVERED', 'inapp'),
      ev('CLICKED', 'inapp', { kind: 'ENGAGEMENT' }),
    ]) {
      await s.c.analytics().ingest(e);
    }
    const range = { from: new Date(Date.now() - 3600000), to: new Date(Date.now() + 3600000) };
    const rates = await s.c.analytics().deliveryRates(range, 'channel');
    const sms = rates.find((r) => r.channel === 'sms')!;
    expect(sms).toMatchObject({
      queued: 2,
      sent: 1,
      delivered: 1,
      failed: 1,
      acceptanceRate: 0.5,
      deliveryRate: 1,
      failureRate: 0.5,
    });
    const costs = await s.c.analytics().costs(range);
    expect(costs.find((c) => c.channel === 'sms')).toMatchObject({
      totalCostMicros: 180000,
      costPerDeliveredMicros: 180000,
    });
    const caps = await s.c.analytics().frequencyCaps(range);
    expect(caps).toMatchObject({ capped: 1, capHitRate: 0.25 });
    const eng = await s.c.analytics().engagement(range);
    expect(eng.find((e) => e.channel === 'inapp')).toMatchObject({
      read: 1,
      clicked: 1,
      readRate: 0.5,
    });
    expect(eng.find((e) => e.channel === 'sms')).toMatchObject({
      read: null,
      readRate: null,
      clickThroughRate: null,
    });
    const summary = await s.c.analytics().summary(range, new Date());
    expect(summary.dlqOpen).toBe(0);
    expect(summary.lastAggregatedAt).not.toBeNull();
  });

  it('computes the rolling 30-day opt-out rate', async () => {
    const u1 = await createUser(s.c);
    await createUser(s.c);
    await s.c.db()('opt_out_events').insert({ user_id: u1, channel: 'sms', source: 'PREFERENCE' });
    await s.c
      .db()('opt_out_events')
      .insert({
        user_id: u1,
        channel: 'email',
        source: 'CONSENT',
        created_at: new Date(Date.now() - 40 * 86400000),
      });
    const r = await s.c.analytics().optOuts(new Date());
    expect(r.optedOutUsers).toBe(1);
    expect(Number(r.totalUsers)).toBeGreaterThanOrEqual(2);
  });
});

describe('Socket.IO authentication', () => {
  it('rejects missing or non-USER tokens and accepts USER tokens', async () => {
    const tryConnect = (token?: string) =>
      new Promise<string>((resolve) => {
        const sock = ioClient(s.baseUrl, {
          auth: token ? { token } : {},
          transports: ['websocket'],
          reconnection: false,
        });
        sock.on('connect', () => (sock.disconnect(), resolve('connected')));
        sock.on('connect_error', (e) => (sock.disconnect(), resolve(e.message)));
      });
    expect(await tryConnect()).toBe('unauthorized');
    expect(await tryConnect('not-a-jwt')).toBe('unauthorized');
    const svc = s.c.auth();
    await svc.createPrincipal({
      kind: 'SERVICE',
      username: 'sock-svc',
      secret: 'secret-1234',
      roles: ['SERVICE'],
    });
    expect(
      await tryConnect((await svc.clientCredentials('sock-svc', 'secret-1234')).accessToken),
    ).toBe('unauthorized');
    const u = await createUser(s.c);
    expect(await tryConnect((await svc.mintUserToken(u)).accessToken)).toBe('connected');
  });
});
