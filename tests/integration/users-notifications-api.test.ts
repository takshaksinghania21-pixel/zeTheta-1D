import request from 'supertest';
import { SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import type { NotificationRow } from '../../src/modules/notifications/types';
import { createUser, principalToken, startStack, type Stack } from '../helpers/stack';

let s: Stack;
let service: string;
let admin: string;
let operator: string;

beforeAll(async () => {
  s = await startStack();
  service = await principalToken(s.c, ['SERVICE']);
  admin = await principalToken(s.c, ['ADMIN']);
  operator = await principalToken(s.c, ['OPERATOR']);
});
afterAll(() => s.close());

const api = () => request(s.server);
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const userToken = async (id: string) => (await s.c.auth().mintUserToken(id)).accessToken;

/** Ingest + process synchronously; returns the event's notifications. */
async function notify(userId: string, code: string): Promise<NotificationRow[]> {
  const r = await s.c.ingestion().ingest(
    {
      eventType: code,
      userId,
      occurredAt: new Date().toISOString(),
      payload: SAMPLE_PAYLOADS[code]!,
    },
    'test',
    `corr-${Math.random().toString(36).slice(2)}-0001`,
  );
  await s.c.processor().process({
    eventId: r.eventId,
    eventType: code,
    userId,
    occurredAt: new Date().toISOString(),
    correlationId: 'corr-users-notifications-0001',
    schemaVersion: 1,
  });
  return s.c.notifications().byEvent(r.eventId);
}

const dispatch = (n: NotificationRow) =>
  s.c.dispatcher().handle({
    notificationId: n.id,
    createdAt: new Date(n.created_at).toISOString(),
    retry: n.retry_count,
    correlationId: n.correlation_id,
  });

describe('users API', () => {
  it('creates a user with masked contacts, audits it and rejects a duplicate externalRef', async () => {
    const body = {
      externalRef: `ext-${Date.now()}`,
      displayName: 'Ravi K',
      segment: 'HNI',
      locale: 'mr',
      timezone: 'Asia/Kolkata',
      contacts: [
        { channel: 'sms', value: '+919811112222', verified: true },
        { channel: 'email', value: 'ravi.k@example.test' },
      ],
    };
    const r = await api().post('/api/v1/users').set(auth(service)).send(body);
    expect(r.status).toBe(201);
    expect(r.headers.location).toBe(`/api/v1/users/${r.body.id}`);
    expect(JSON.stringify(r.body)).not.toContain('9811112222');
    expect(r.body.contacts.map((x: { masked: string }) => x.masked).sort()).toEqual([
      '+91XXXX2222',
      'r***@example.test',
    ]);
    expect((await s.c.audit().list({ targetId: r.body.id, limit: 5 }))[0]).toMatchObject({
      action: 'USER_CREATED',
    });
    expect((await api().post('/api/v1/users').set(auth(service)).send(body)).status).toBe(409);
  });

  it('lets users read only themselves; operators read anyone', async () => {
    const a = await createUser(s.c);
    const b = await createUser(s.c);
    expect(
      (
        await api()
          .get(`/api/v1/users/${a}`)
          .set(auth(await userToken(a)))
      ).status,
    ).toBe(200);
    expect(
      (
        await api()
          .get(`/api/v1/users/${b}`)
          .set(auth(await userToken(a)))
      ).status,
    ).toBe(403);
    const op = await api().get(`/api/v1/users/${b}`).set(auth(operator));
    expect(op.status).toBe(200);
    expect(op.body).not.toHaveProperty('anonymizedAt');
  });

  it('adds and removes a contact (audited, masked)', async () => {
    const u = await createUser(s.c);
    const add = await api()
      .post(`/api/v1/users/${u}/contacts`)
      .set(auth(await userToken(u)))
      .send({ channel: 'email', value: 'second@example.test' });
    expect(add.status).toBe(201);
    expect(add.body.masked).toBe('s***@example.test');
    const del = await api()
      .delete(`/api/v1/users/${u}/contacts/${add.body.id}`)
      .set(auth(await userToken(u)));
    expect(del.status).toBe(204);
    const other = await createUser(s.c);
    expect(
      (
        await api()
          .delete(`/api/v1/users/${other}/contacts/${add.body.id}`)
          .set(auth(await userToken(u)))
      ).status,
    ).toBe(403);
  });
});

describe('notification visibility and engagement rules', () => {
  it('hides other users’ notifications (404, existence not leaked) but not from operators', async () => {
    const owner = await createUser(s.c);
    const stranger = await createUser(s.c);
    const [n] = await notify(owner, 'TXNX-003');
    const url = `/api/v1/notifications/${n!.id}`;
    expect(
      (
        await api()
          .get(url)
          .set(auth(await userToken(owner)))
      ).status,
    ).toBe(200);
    expect(
      (
        await api()
          .get(url)
          .set(auth(await userToken(stranger)))
      ).status,
    ).toBe(404);
    expect((await api().get(url).set(auth(operator))).status).toBe(200);
  });

  it('lists delivery attempts and the provider-reported delivery status', async () => {
    const u = await createUser(s.c);
    const sms = (await notify(u, 'TXNX-003')).find((n) => n.channel === 'sms')!;
    await dispatch(sms);
    const attempts = await api()
      .get(`/api/v1/notifications/${sms.id}/attempts`)
      .set(auth(operator));
    expect(attempts.status).toBe(200);
    expect(attempts.body.items[0]).toMatchObject({
      provider: 'mock-sms-primary',
      status: 'SUCCESS',
    });
    const status = await api().get(`/api/v1/deliveries/${sms.id}/status`).set(auth(admin));
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ state: 'SENT', provider: 'mock-sms-primary' });
    expect(status.body.providerStatus).not.toBeNull();
    expect(status.body.lastAttempt).toMatchObject({ status: 'SUCCESS' });
  });

  it('only in-app can be marked read, only in-app/push can be clicked; both are idempotent', async () => {
    const u = await createUser(s.c);
    const token = await userToken(u);
    const ns = await notify(u, 'TXNX-003');
    for (const n of ns) await dispatch(n);
    const sms = ns.find((n) => n.channel === 'sms')!;
    const inapp = ns.find((n) => n.channel === 'inapp')!;
    expect((await api().post(`/api/v1/notifications/${sms.id}/read`).set(auth(token))).status).toBe(
      409,
    );
    expect(
      (await api().post(`/api/v1/notifications/${sms.id}/click`).set(auth(token))).status,
    ).toBe(400);
    const read1 = await api().post(`/api/v1/notifications/${inapp.id}/read`).set(auth(token));
    const read2 = await api().post(`/api/v1/notifications/${inapp.id}/read`).set(auth(token));
    expect([read1.body.state, read2.body.state]).toEqual(['READ', 'READ']);
    const c1 = await api().post(`/api/v1/notifications/${inapp.id}/click`).set(auth(token));
    const c2 = await api().post(`/api/v1/notifications/${inapp.id}/click`).set(auth(token));
    expect(c1.body.clickedAt).not.toBeNull();
    expect(c2.body.clickedAt).toBe(c1.body.clickedAt);
  });

  it('filters the caller’s own notification list by channel and unread state', async () => {
    const u = await createUser(s.c);
    const token = await userToken(u);
    await notify(u, 'TXNX-003');
    const all = await api().get('/api/v1/notifications').set(auth(token));
    expect(all.body.items.length).toBe(3);
    const sms = await api().get('/api/v1/notifications?channel=sms').set(auth(token));
    expect(sms.body.items.map((n: { channel: string }) => n.channel)).toEqual(['sms']);
    const unread = await api().get('/api/v1/notifications?unreadOnly=true').set(auth(token));
    expect(unread.status).toBe(200);
  });
});

describe('DLQ operator actions on event entries', () => {
  it('re-publishes an escalated CRITICAL event to the critical topic; resolves only once', async () => {
    const u = await createUser(s.c, {
      contacts: [{ channel: 'email', value: 'only@example.test' }],
    });
    await notify(u, 'RISK-001'); // no SMS/push contact → ESCALATE_MANUAL_CALL
    const { items } = await s.c
      .dlqRepo()
      .list({ reason: 'ESCALATE_MANUAL_CALL', limit: 20, offset: 0 });
    const entry = items.find((e) => (e.payload as { userId?: string }).userId === u)!;
    expect(entry.classification).toBe('PERMANENT');
    await s.c.db()('outbox').where({ destination: 'KAFKA', target: s.c.topics.critical }).del();
    const retried = await api()
      .post(`/api/v1/dlq/${entry.id}/retry`)
      .set(auth(operator))
      .send({ note: 'contact details fixed' });
    expect(retried.status).toBe(200);
    const republished = await s.c
      .db()('outbox')
      .where({ destination: 'KAFKA', target: s.c.topics.critical });
    expect(republished).toHaveLength(1);
    const again = await api().post(`/api/v1/dlq/${entry.id}/retry`).set(auth(operator)).send({});
    expect(again.status).toBe(409);
  });

  it('refuses to auto-retry a poison entry and filters by classification', async () => {
    const id = await s.c.dlqRepo().insert(s.c.db(), {
      source: 'POISON',
      reasonCode: 'POISON_MESSAGE',
      reasonMessage: 'unparseable',
      attempts: 1,
    });
    expect((await api().post(`/api/v1/dlq/${id}/retry`).set(auth(operator)).send({})).status).toBe(
      409,
    );
    const list = await api()
      .get('/api/v1/dlq?classification=PERMANENT&reason=POISON_MESSAGE')
      .set(auth(operator));
    expect(list.body.items.map((e: { id: string }) => e.id)).toContain(id);
    const discard = await api()
      .post(`/api/v1/dlq/${id}/resolve`)
      .set(auth(admin))
      .send({ resolution: 'DISCARDED', note: 'bad producer payload' });
    expect(discard.status).toBe(200);
  });
});
