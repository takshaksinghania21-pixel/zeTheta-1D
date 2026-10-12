import jwt from 'jsonwebtoken';
import request from 'supertest';
import { signGeneric } from '../../src/modules/webhooks/signatures';
import { hmacSha256Hex } from '../../src/common/crypto';
import { twilioSignature } from '../../src/modules/webhooks/signatures';
import { SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import { createUser, principalToken, startStack, type Stack } from '../helpers/stack';

let s: Stack;
let service: string;
let admin: string;
let operator: string;
let userId: string;
let userToken: string;

beforeAll(async () => {
  s = await startStack({
    TWILIO_AUTH_TOKEN: 'twilio-test-token',
    WHATSAPP_APP_SECRET: 'meta-app-secret',
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    MSG91_WEBHOOK_SECRET: 'msg91-secret',
  });
  service = await principalToken(s.c, ['SERVICE']);
  admin = await principalToken(s.c, ['ADMIN']);
  operator = await principalToken(s.c, ['OPERATOR']);
  userId = await createUser(s.c);
  userToken = (await s.c.auth().mintUserToken(userId)).accessToken;
});
afterAll(() => s.close());

const api = () => request(s.server);
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const event = (over: Record<string, unknown> = {}) => ({
  eventType: 'TXNX-001',
  userId,
  occurredAt: '2026-01-15T09:20:00+05:30',
  payload: SAMPLE_PAYLOADS['TXNX-001'],
  ...over,
});

describe('health, metrics and API docs', () => {
  it('reports liveness and dependency readiness', async () => {
    expect((await api().get('/health/live')).status).toBe(200);
    const r = await api().get('/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ postgres: 'up', redis: 'up', rabbitmq: 'up', kafka: 'up' });
  });

  it('maps malformed JSON, oversized bodies and unknown routes to safe error envelopes', async () => {
    const bad = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .set('content-type', 'application/json')
      .send('{"eventType":');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Malformed JSON body',
    });
    const big = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(1_100_000) }));
    expect(big.status).toBe(413);
    const missing = await api().get('/api/v1/no-such-route').set(auth(service));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    expect(missing.body.error.correlationId).toBeTruthy();
  });

  it('exposes Prometheus metrics', async () => {
    const r = await api().get('/metrics');
    expect(r.status).toBe(200);
    expect(r.text).toContain('http_requests_total');
    expect(r.text).toContain('notification_transitions_total');
  });

  it('publishes an OpenAPI 3.0 document covering every implemented route', async () => {
    const r = await api().get('/api/v1/openapi.json');
    expect(r.body.openapi).toBe('3.0.3');
    const { createApi } = await import('../../src/app');
    const routes = createApi(s.c).routes;
    const paths = r.body.paths as Record<string, Record<string, unknown>>;
    for (const route of routes) {
      const p = `/api/v1${route.path.replace(/:([A-Za-z]+)/g, '{$1}')}`;
      expect(paths[p]?.[route.method]).toBeDefined();
    }
    expect(routes.length).toBeGreaterThanOrEqual(45);
    expect((await api().get('/api/docs/')).status).toBe(200);
  });

  it('sets security headers and propagates correlation ids', async () => {
    const r = await api().get('/health/live').set('x-correlation-id', 'client-corr-12345');
    expect(r.headers['x-correlation-id']).toBe('client-corr-12345');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-powered-by']).toBeUndefined();
    const bad = await api().get('/health/live').set('x-correlation-id', '<script>');
    expect(bad.headers['x-correlation-id']).not.toBe('<script>');
  });

  it('allows configured CORS origins only', async () => {
    const ok = await api()
      .options('/api/v1/events')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const no = await api()
      .options('/api/v1/events')
      .set('origin', 'https://evil.example')
      .set('access-control-request-method', 'POST');
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns consistent errors without internals for unknown routes and malformed JSON', async () => {
    const r = await api().get('/api/v1/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toMatchObject({ code: 'NOT_FOUND' });
    const bad = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .set('content-type', 'application/json')
      .send('{bad');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts/);
  });
});

describe('authentication (edge 12)', () => {
  it('rejects missing, malformed, tampered and expired tokens', async () => {
    expect((await api().get('/api/v1/taxonomy/events')).status).toBe(401);
    expect(
      (await api().get('/api/v1/taxonomy/events').set('authorization', 'Basic abc')).status,
    ).toBe(401);
    const tampered = `${service.slice(0, -4)}AAAA`;
    expect((await api().get('/api/v1/taxonomy/events').set(auth(tampered))).status).toBe(401);
    const expired = jwt.sign({ usr: 'x', roles: ['ADMIN'], typ: 'access' }, s.config.JWT_SECRET, {
      subject: 'x',
      issuer: s.config.JWT_ISSUER,
      audience: s.config.JWT_AUDIENCE,
      expiresIn: -10,
    });
    const r = await api().get('/api/v1/taxonomy/events').set(auth(expired));
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/expired/);
    const wrongAud = jwt.sign({ usr: 'x', roles: ['ADMIN'], typ: 'access' }, s.config.JWT_SECRET, {
      subject: 'x',
      issuer: s.config.JWT_ISSUER,
      audience: 'other',
      expiresIn: 60,
    });
    expect((await api().get('/api/v1/taxonomy/events').set(auth(wrongAud))).status).toBe(401);
    const noneAlg = jwt.sign({ usr: 'x', roles: ['ADMIN'], typ: 'access' }, '', {
      algorithm: 'none',
      subject: 'x',
    });
    expect((await api().get('/api/v1/taxonomy/events').set(auth(noneAlg))).status).toBe(401);
  });

  it('issues tokens via password and client-credentials grants and rejects bad secrets', async () => {
    await s.c.auth().createPrincipal({
      kind: 'HUMAN',
      username: 'alice',
      secret: 'correct horse',
      roles: ['OPERATOR'],
    });
    expect(
      (
        await api()
          .post('/api/v1/auth/token')
          .send({ grantType: 'password', username: 'alice', password: 'wrong' })
      ).status,
    ).toBe(401);
    expect(
      (
        await api()
          .post('/api/v1/auth/token')
          .send({ grantType: 'password', username: 'nobody', password: 'x' })
      ).status,
    ).toBe(401);
    const ok = await api()
      .post('/api/v1/auth/token')
      .send({ grantType: 'password', username: 'alice', password: 'correct horse' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(
      (
        await api().post('/api/v1/auth/token').send({
          grantType: 'client_credentials',
          clientId: 'alice',
          clientSecret: 'correct horse',
        })
      ).status,
    ).toBe(401);
  });

  it('rotates refresh tokens and revokes the family when a used token is replayed', async () => {
    await s.c.auth().createPrincipal({
      kind: 'HUMAN',
      username: 'bob',
      secret: 'pw-123456',
      roles: ['OPERATOR'],
    });
    const login = await api()
      .post('/api/v1/auth/token')
      .send({ grantType: 'password', username: 'bob', password: 'pw-123456' });
    const r1 = login.body.refreshToken as string;
    const rot = await api()
      .post('/api/v1/auth/token')
      .send({ grantType: 'refresh_token', refreshToken: r1 });
    expect(rot.status).toBe(200);
    expect(rot.body.refreshToken).not.toBe(r1);
    const replay = await api()
      .post('/api/v1/auth/token')
      .send({ grantType: 'refresh_token', refreshToken: r1 });
    expect(replay.status).toBe(401);
    expect(replay.body.error.message).toMatch(/reuse/);
    // the legitimately rotated token is now revoked as well
    expect(
      (
        await api()
          .post('/api/v1/auth/token')
          .send({ grantType: 'refresh_token', refreshToken: rot.body.refreshToken })
      ).status,
    ).toBe(401);
  });

  it('logs out by revoking the refresh token family', async () => {
    await s.c.auth().createPrincipal({
      kind: 'HUMAN',
      username: 'carol',
      secret: 'pw-123456',
      roles: ['OPERATOR'],
    });
    const login = await api()
      .post('/api/v1/auth/token')
      .send({ grantType: 'password', username: 'carol', password: 'pw-123456' });
    expect(
      (await api().post('/api/v1/auth/revoke').send({ refreshToken: login.body.refreshToken }))
        .status,
    ).toBe(204);
    expect(
      (
        await api()
          .post('/api/v1/auth/token')
          .send({ grantType: 'refresh_token', refreshToken: login.body.refreshToken })
      ).status,
    ).toBe(401);
  });

  it('mints USER tokens only for trusted callers', async () => {
    expect(
      (await api().post('/api/v1/auth/user-token').set(auth(operator)).send({ userId })).status,
    ).toBe(403);
    const r = await api().post('/api/v1/auth/user-token').set(auth(service)).send({ userId });
    expect(r.status).toBe(200);
    expect(s.c.auth().verifyAccessToken(r.body.accessToken)).toMatchObject({
      roles: ['USER'],
      userId,
    });
  });
});

describe('authorisation (RBAC)', () => {
  it('edge 13: blocks unauthorised DLQ operations', async () => {
    expect((await api().get('/api/v1/dlq').set(auth(userToken))).status).toBe(403);
    expect((await api().get('/api/v1/dlq').set(auth(service))).status).toBe(403);
    expect((await api().get('/api/v1/dlq').set(auth(operator))).status).toBe(200);
    const fake = '00000000-0000-4000-8000-000000000000';
    expect(
      (await api().post(`/api/v1/dlq/${fake}/retry`).set(auth(userToken)).send({})).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/dlq/${fake}/resolve`)
          .set(auth(operator))
          .send({ resolution: 'DISCARDED', note: 'nope' })
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/dlq/${fake}/resolve`)
          .set(auth(admin))
          .send({ resolution: 'DISCARDED', note: 'none' })
      ).status,
    ).toBe(404);
  });

  it('isolates end users from each other', async () => {
    const other = await createUser(s.c);
    expect(
      (await api().get(`/api/v1/users/${other}/preferences`).set(auth(userToken))).status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/notifications?userId=${other}`).set(auth(userToken))).status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/users/${userId}/preferences`).set(auth(userToken))).status,
    ).toBe(200);
    expect((await api().post('/api/v1/events').set(auth(userToken)).send(event())).status).toBe(
      403,
    );
  });

  it('restricts privileged writes to ADMIN', async () => {
    expect(
      (
        await api()
          .post('/api/v1/templates')
          .set(auth(operator))
          .send({ eventType: 'TXNX-001', channel: 'sms', locale: 'en', body: 'x' })
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/users/${userId}/anonymize`)
          .set(auth(operator))
          .send({ reason: 'test' })
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .patch('/api/v1/ops/providers/mock-push')
          .set(auth(operator))
          .send({ enabled: false })
      ).status,
    ).toBe(403);
  });
});

describe('event ingestion', () => {
  it('accepts valid events (202) and returns exact duplicates idempotently (200)', async () => {
    const a = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(event({ payload: { ...SAMPLE_PAYLOADS['TXNX-001'], orderId: 'API-1' } }));
    expect(a.status).toBe(202);
    expect(a.headers.location).toBe(`/api/v1/events/${a.body.eventId}`);
    const b = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(event({ payload: { ...SAMPLE_PAYLOADS['TXNX-001'], orderId: 'API-1' } }));
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({ status: 'DUPLICATE', eventId: a.body.eventId });
    const status = await api().get(`/api/v1/events/${a.body.eventId}`).set(auth(operator));
    expect(status.body).toMatchObject({ id: a.body.eventId, status: 'RECEIVED' });
    expect(status.body.payload).toBeUndefined();
  });

  it('rejects reuse of an idempotency key with a different payload (409)', async () => {
    await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(event({ idempotencyKey: 'client-key-001' }));
    const r = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(
        event({
          idempotencyKey: 'client-key-001',
          payload: { ...SAMPLE_PAYLOADS['TXNX-001'], quantity: 99 },
        }),
      );
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects unknown event types and schema violations with field details (422)', async () => {
    const unknown = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(event({ eventType: 'ABCD-999' }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('UNKNOWN_EVENT_TYPE');
    const bad = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(event({ payload: { ...SAMPLE_PAYLOADS['TXNX-001'], quantity: 0 } }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('payload.quantity');
    const noUser = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send(event({ userId: '00000000-0000-4000-8000-000000000000' }));
    expect(noUser.status).toBe(422);
  });

  it('rejects unexpected envelope fields (400)', async () => {
    const r = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send({ ...event(), admin: true });
    expect(r.status).toBe(400);
    expect(r.body.error.details[0].code).toBe('unrecognized_keys');
  });

  it('ingests batches with per-item results and exposes batch status', async () => {
    const r = await api()
      .post('/api/v1/events/batch')
      .set(auth(service))
      .send({
        events: [
          event({ payload: { ...SAMPLE_PAYLOADS['TXNX-001'], orderId: 'B-1' } }),
          event({ eventType: 'NOPE-001' }),
          { junk: true },
          event({ payload: { ...SAMPLE_PAYLOADS['TXNX-001'], orderId: 'B-1' } }),
        ],
      });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ accepted: 1, rejected: 2, duplicates: 1 });
    const b = await api().get(`/api/v1/events/batches/${r.body.batchId}`).set(auth(operator));
    expect(b.body.statusCounts).toEqual({ RECEIVED: 1 });
    expect(
      (await api().post('/api/v1/events/batch').set(auth(service)).send({ events: [] })).status,
    ).toBe(400);
  });

  it('lists the 25+ registered event types', async () => {
    const r = await api().get('/api/v1/taxonomy/events').set(auth(userToken));
    expect(r.body.count).toBeGreaterThanOrEqual(25);
  });
});

describe('notification storm dedup (PDF §B2.4)', () => {
  const alert = (over: Record<string, unknown>, at: string) => ({
    eventType: 'MKTX-001',
    userId,
    occurredAt: at,
    payload: { ...SAMPLE_PAYLOADS['MKTX-001'], ...over },
  });

  it('collapses repeated price alerts per user, stock and 60 s window; a new window passes', async () => {
    const first = await s.c
      .ingestion()
      .ingest(alert({ alertId: 'ST-1', symbol: 'STORM' }, '2026-10-12T10:00:01Z'), 'feed', 'c-1');
    const burst = await s.c
      .ingestion()
      .ingest(
        alert({ alertId: 'ST-2', symbol: 'STORM', currentPrice: '799.10' }, '2026-10-12T10:00:09Z'),
        'feed',
        'c-2',
      );
    expect(first.status).toBe('ACCEPTED');
    expect(burst).toMatchObject({ status: 'DUPLICATE', eventId: first.eventId });
    const later = await s.c
      .ingestion()
      .ingest(alert({ alertId: 'ST-3', symbol: 'STORM' }, '2026-10-12T10:01:05Z'), 'feed', 'c-3');
    expect(later.status).toBe('ACCEPTED');
    const metricsText = (await api().get('/metrics')).text;
    expect(metricsText).toMatch(
      /notification_events_received_total\{[^}]*event_type="MKTX-001"[^}]*outcome="deduplicated"[^}]*\} [1-9]/,
    );
  });

  it('keeps 409 for an explicit idempotency key reused with a different payload', async () => {
    const key = `explicit-key-${Date.now()}`;
    await s.c
      .ingestion()
      .ingest(
        { ...alert({ symbol: 'KEYED' }, new Date().toISOString()), idempotencyKey: key },
        'feed',
        'c-4',
      );
    await expect(
      s.c.ingestion().ingest(
        {
          ...alert({ symbol: 'KEYED', currentPrice: '1.00' }, new Date().toISOString()),
          idempotencyKey: key,
        },
        'feed',
        'c-5',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('PDF Appendix A contract (POST /api/v1/events)', () => {
  // The Appendix A request body verbatim, except: a real user id (with the usr_
  // prefix the sample uses) and dates moved into the future so `deadline` is valid.
  const sample = () => ({
    event_type: 'RISK-001',
    event_id: `EVT-2099-03-19-MC-${Date.now()}`,
    source_system: 'margin_engine',
    timestamp: '2099-03-19T10:15:23.456Z',
    priority: 1,
    user_id: `usr_${userId}`,
    payload: {
      shortfall_amount: 125000.0,
      current_margin: 375000.0,
      required_margin: 500000.0,
      deadline: '2099-03-19T11:30:00.000Z',
      affected_positions: [
        { symbol: 'RELIANCE', qty: 500, current_value: 620000.0 },
        { symbol: 'INFY', qty: 200, current_value: 340000.0 },
      ],
      auto_square_off_time: '2099-03-19T12:00:00.000Z',
    },
    idempotency_key: `margin-call-usr_a1b2c3d4-2099-03-19T10:15-${Date.now()}`,
  });

  it('accepts the sample request and answers 202 in the Appendix A shape', async () => {
    const r = await api().post('/api/v1/events').set(auth(service)).send(sample());
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({
      event_id: expect.stringMatching(/^EVT-2099-03-19-MC-/),
      status: 'CREATED',
      channels_targeted: ['sms', 'push', 'in_app'],
      estimated_delivery_ms: expect.any(Number),
      created_at: expect.any(String),
    });
    expect(r.body.notification_id).toMatch(/^[0-9a-f-]{36}$/);
    const ev = await s.c.ingestion().getEvent(r.body.notification_id);
    expect(ev?.payload).toMatchObject({
      shortfallAmount: '125000',
      affectedPositions: expect.any(Array),
    });
  });

  it('answers 422 VALIDATION_FAILED with field-level details and a request id', async () => {
    const bad = sample();
    bad.payload.shortfall_amount = -5;
    bad.payload.deadline = '2020-01-01T00:00:00.000Z';
    const r = await api().post('/api/v1/events').set(auth(service)).send(bad);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      error: 'VALIDATION_FAILED',
      message: 'Event payload validation failed',
    });
    expect(r.body.details).toEqual(
      expect.arrayContaining([
        { field: 'payload.shortfall_amount', error: 'must be a positive number' },
        { field: 'payload.deadline', error: 'must be a future timestamp' },
      ]),
    );
    expect(r.body.request_id).toBeTruthy();
  });

  it('answers an exact re-delivery with 200 DUPLICATE and the same id', async () => {
    const body = sample();
    const first = await api().post('/api/v1/events').set(auth(service)).send(body);
    const again = await api().post('/api/v1/events').set(auth(service)).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      status: 'DUPLICATE',
      notification_id: first.body.notification_id,
    });
  });

  it('returns 404 for unknown events and batches', async () => {
    const id = '00000000-0000-4000-8000-000000000999';
    expect((await api().get(`/api/v1/events/${id}`).set(auth(service))).status).toBe(404);
    expect((await api().get(`/api/v1/events/batches/${id}`).set(auth(service))).status).toBe(404);
  });

  it('rejects unexpected envelope fields in the PDF shape too', async () => {
    const r = await api()
      .post('/api/v1/events')
      .set(auth(service))
      .send({ ...sample(), extra: true });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('VALIDATION_FAILED');
  });
});

describe('PDF Appendix A contract: preferences, analytics, notification status', () => {
  it('GET /users/:id/preferences includes the Appendix A view', async () => {
    const u = await createUser(s.c);
    const r = await api().get(`/api/v1/users/${u}/preferences`).set(auth(admin));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      user_id: u,
      global_preferences: { quiet_hours: { start: '21:00', end: '08:00' }, language: 'en' },
      updated_at: expect.any(String),
    });
    expect(r.body.category_preferences.map((c: { category: string }) => c.category).sort()).toEqual(
      ['MKTX', 'REGX', 'RISK', 'SIPX', 'TXNX'],
    );
    expect(r.body.category_preferences[0].channels).toHaveProperty('in_app');
    expect(r.body.regulatory_overrides).toEqual(
      expect.arrayContaining([
        { event_type: 'RISK-001', channels: ['sms', 'push'], cannot_disable: true },
        { event_type: 'RISK-002', channels: ['sms', 'push', 'email'], cannot_disable: true },
        { event_type: 'REGX-001', channels: ['sms', 'email'], cannot_disable: true },
      ]),
    );
  });

  it('PUT /users/:id/preferences updates one category, warns, and refreshes the cache', async () => {
    const u = await createUser(s.c);
    await api().get(`/api/v1/users/${u}/preferences`).set(auth(admin)); // populate the cache
    const r = await api()
      .put(`/api/v1/users/${u}/preferences`)
      .set(auth(admin))
      .send({
        category: 'MKTX',
        channels: { sms: false, email: false, push: true, whatsapp: false, in_app: true },
        digest_mode: 'daily',
      });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'updated', category: 'MKTX', cache_invalidated: true });
    expect(r.body.warnings.join(' ')).toMatch(/Email disabled for MKTX .*MKTX-005/);
    expect(r.body.warnings.join(' ')).toMatch(/Regulatory notifications \(MKTX-002\)/);
    const after = await api().get(`/api/v1/users/${u}/preferences`).set(auth(admin));
    const mktx = after.body.category_preferences.find(
      (c: { category: string }) => c.category === 'MKTX',
    );
    expect(mktx).toMatchObject({ channels: { email: false, push: true }, digest_mode: 'daily' });
    expect(after.body.version).toBe(r.headers.etag ? Number(r.headers.etag) : after.body.version);
  });

  it('rejects an unknown category and unknown channel keys', async () => {
    const u = await createUser(s.c);
    const bad = await api()
      .put(`/api/v1/users/${u}/preferences`)
      .set(auth(admin))
      .send({ category: 'ABCD', channels: { sms: true } });
    expect(bad.status).toBe(400);
    const unknown = await api()
      .put(`/api/v1/users/${u}/preferences`)
      .set(auth(admin))
      .send({ category: 'MKTX', channels: { pager: true } });
    expect(unknown.status).toBe(400);
  });

  it('GET /analytics/delivery-rates?period=7d&channel=all returns the Appendix A shape', async () => {
    const r = await api()
      .get('/api/v1/analytics/delivery-rates?period=7d&channel=all')
      .set(auth(operator));
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(
      [
        'by_channel',
        'by_priority',
        'cost_summary',
        'dnd_blocks',
        'frequency_cap_hits',
        'period',
        'summary',
      ].sort(),
    );
    expect(r.body.summary).toHaveProperty('overall_delivery_rate');
    expect(r.body.dnd_blocks).toHaveProperty('transactional_blocked');
    expect(new Date(r.body.period.end).getTime() - new Date(r.body.period.start).getTime()).toBe(
      7 * 86400000,
    );
  });

  it.each(['channel-performance', 'opt-out-trends', 'preference-changes'])(
    'GET /analytics/%s responds',
    async (path) => {
      const r = await api().get(`/api/v1/analytics/${path}?period=30d`).set(auth(operator));
      expect(r.status).toBe(200);
      expect(r.body.data).toBeDefined();
    },
  );

  it('GET /notifications/:id carries state_history and compliance evidence', async () => {
    const u = await createUser(s.c);
    const ev = await s.c.ingestion().ingest(
      {
        ...event({ userId: u, eventType: 'TXNX-003', payload: SAMPLE_PAYLOADS['TXNX-003'] }),
      } as never,
      'test',
      'corr-detail-0001',
    );
    await s.c.processor().process({
      eventId: ev.eventId,
      eventType: 'TXNX-003',
      userId: u,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-detail-0001',
      schemaVersion: 1,
    });
    const sms = (await s.c.notifications().byEvent(ev.eventId)).find((n) => n.channel === 'sms')!;
    const before = await api().get(`/api/v1/notifications/${sms.id}`).set(auth(operator));
    expect(before.body.compliance.dnd_checked).toBe(false); // DND runs at dispatch, not routing
    await s.c.dispatcher().handle({
      notificationId: sms.id,
      createdAt: new Date(sms.created_at).toISOString(),
      retry: 0,
      correlationId: sms.correlation_id,
    });
    const r = await api().get(`/api/v1/notifications/${sms.id}`).set(auth(operator));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      notification_id: sms.id,
      event_type: 'TXNX-003',
      priority: 2,
      priorityLabel: 'HIGH',
      channel: 'sms',
      status: 'SENT',
      template_id: 'TXNX-003-v1',
      compliance: {
        classification: 'TRANSACTIONAL',
        dnd_checked: true,
        dnd_result: 'NOT_APPLICABLE',
        frequency_cap_checked: true,
        frequency_cap_result: 'WITHIN_LIMITS',
      },
    });
    expect(r.body.state_history.map((h: { status: string }) => h.status)).toEqual([
      'CREATED',
      'ENRICHED',
      'ROUTED',
      'QUEUED',
      'SENT',
    ]);
    expect(r.body.external_id).toBeTruthy();
    expect(r.body.compliance.dnd_check_timestamp).toBeTruthy();
  });
});

describe('observability endpoints (PDF §A11, Day 12–13)', () => {
  it('GET /health reports dependencies and every provider', async () => {
    const r = await api().get('/health');
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ postgres: 'up', redis: 'up', rabbitmq: 'up', kafka: 'up' });
    expect(r.body.providers.length).toBeGreaterThan(0);
    expect(r.body.providers[0]).toHaveProperty('circuit');
  });

  it('serves Swagger UI at /api-docs', async () => {
    const r = await api().get('/api-docs/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('swagger');
  });

  it('exposes the §A11.1 metric names', async () => {
    const text = (await api().get('/metrics')).text;
    for (const name of [
      'notification_events_received_total',
      'notification_delivery_total',
      'notification_delivery_latency_seconds',
      'notification_frequency_cap_hits_total',
      'notification_dnd_blocks_total',
      'notification_dlq_depth',
      'notification_retry_total',
      'kafka_consumer_lag',
      'delivery_provider_circuit_state',
    ])
      expect(text).toContain(`# TYPE ${name}`);
  });
});

describe('preferences and consent', () => {
  it('returns resolved preferences with sources and the hierarchy', async () => {
    const r = await api().get(`/api/v1/users/${userId}/preferences`).set(auth(service));
    expect(r.body.effective.sources['channels.sms']).toBe('SYSTEM');
    expect(r.body.hierarchy).toHaveLength(4);
    expect(r.headers.etag).toBeDefined();
  });

  it('updates channels, categories, digest and quiet hours with validation', async () => {
    const ch = await api()
      .put(`/api/v1/users/${userId}/preferences/channels`)
      .set(auth(service))
      .send({ whatsapp: true });
    expect(ch.body.effective.channels.whatsapp).toBe(true);
    const cat = await api()
      .put(`/api/v1/users/${userId}/preferences/categories`)
      .set(auth(service))
      .send({ MARKET: { enabled: false } });
    expect(cat.body.effective.categories.MARKET.enabled).toBe(false);
    const dg = await api()
      .put(`/api/v1/users/${userId}/preferences/digest`)
      .set(auth(service))
      .send({ enabled: true, frequency: 'WEEKLY', deliveryTime: '09:00', categories: ['MARKET'] });
    expect(dg.body.effective.digest.frequency).toBe('WEEKLY');
    const short = await api()
      .put(`/api/v1/users/${userId}/preferences/quiet-hours`)
      .set(auth(service))
      .send({ enabled: true, start: '23:00', end: '02:00' });
    expect(short.status).toBe(400);
    expect(short.body.error.details[0].message).toMatch(/at least 6 hours/);
    const tz = await api()
      .put(`/api/v1/users/${userId}/preferences/quiet-hours`)
      .set(auth(service))
      .send({ enabled: true, start: '22:00', end: '07:00', timezone: 'Not/AZone' });
    expect(tz.status).toBe(400);
    const ok = await api()
      .put(`/api/v1/users/${userId}/preferences/quiet-hours`)
      .set(auth(service))
      .send({ enabled: true, start: '22:00', end: '07:00', timezone: 'Europe/London' });
    expect(ok.body.effective.timezone).toBe('Europe/London');
    expect(
      (
        await api()
          .put(`/api/v1/users/${userId}/preferences/channels`)
          .set(auth(service))
          .send({ fax: true })
      ).status,
    ).toBe(400);
  });

  it('records opt-outs when a channel is switched off', async () => {
    await api()
      .put(`/api/v1/users/${userId}/preferences/channels`)
      .set(auth(service))
      .send({ email: false });
    const rows = await s.c
      .db()('opt_out_events')
      .where({ user_id: userId, channel: 'email', source: 'PREFERENCE' });
    expect(rows).toHaveLength(1);
  });

  it('supports optimistic concurrency with If-Match', async () => {
    const cur = await api().get(`/api/v1/users/${userId}/preferences`).set(auth(service));
    const stale = String(Number(cur.headers.etag) - 1);
    expect(
      (
        await api()
          .put(`/api/v1/users/${userId}/preferences/locale`)
          .set(auth(service))
          .set('if-match', stale)
          .send({ locale: 'hi' })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .put(`/api/v1/users/${userId}/preferences/locale`)
          .set(auth(service))
          .set('if-match', cur.headers.etag as string)
          .send({ locale: 'hi' })
      ).status,
    ).toBe(200);
  });

  it('rate-limits preference updates to 10 per minute per principal', async () => {
    const u = await createUser(s.c);
    const t = (await s.c.auth().mintUserToken(u)).accessToken;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++)
      codes.push(
        (
          await api()
            .put(`/api/v1/users/${u}/preferences/channels`)
            .set(auth(t))
            .send({ push: i % 2 === 0 })
        ).status,
      );
    expect(codes.filter((x) => x === 200)).toHaveLength(10);
    expect(codes.slice(-1)[0]).toBe(429);
    const last = await api()
      .put(`/api/v1/users/${u}/preferences/channels`)
      .set(auth(t))
      .send({ push: true });
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    const status = await api().get('/api/v1/rate-limit/status').set(auth(t));
    expect(status.body.limits.preferences.remaining).toBe(0);
  });

  it('records consent changes with source and audit history; WhatsApp opt-in is separate', async () => {
    const g = await api()
      .post(`/api/v1/users/${userId}/consents`)
      .set(auth(userToken))
      .send({
        channel: 'whatsapp',
        purpose: 'TRANSACTIONAL',
        status: 'GRANTED',
        source: 'APP',
        evidence: { screen: 'settings' },
      });
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({
      channel: 'whatsapp',
      status: 'GRANTED',
      source: 'APP',
      recordedBy: `user:${userId}`,
    });
    await api().post(`/api/v1/users/${userId}/consents`).set(auth(userToken)).send({
      channel: 'whatsapp',
      purpose: 'TRANSACTIONAL',
      status: 'REVOKED',
      source: 'SMS_REPLY',
    });
    const list = await api().get(`/api/v1/users/${userId}/consents`).set(auth(operator));
    expect(list.body.history).toHaveLength(2);
    expect(
      list.body.current.find((c: { channel: string }) => c.channel === 'whatsapp').status,
    ).toBe('REVOKED');
    const audit = await api()
      .get(`/api/v1/ops/audit?targetId=${userId}&action=CONSENT_REVOKED`)
      .set(auth(admin));
    expect(audit.body.items).toHaveLength(1);
  });
});

describe('compliance endpoints', () => {
  it('imports DND fixtures (hashing numbers) and looks them up via POST', async () => {
    const imp = await api()
      .post('/api/v1/compliance/dnd/imports')
      .set(auth(admin))
      .send({
        source: 'synthetic-test',
        registrySnapshotAt: new Date().toISOString(),
        entries: [{ phone: '+919800000099', status: 'FULLY_BLOCKED' }],
      });
    expect(imp.status).toBe(201);
    const stored = await s.c.db()('dnd_registry_entries').select('phone_hash');
    expect(JSON.stringify(stored)).not.toContain('9800000099');
    const l = await api()
      .post('/api/v1/compliance/dnd/lookup')
      .set(auth(operator))
      .send({ phone: '+919800000099' });
    expect(l.body).toMatchObject({
      status: 'FULLY_BLOCKED',
      decision: { outcome: 'BLOCK', rule: 'DND_FULLY_BLOCKED' },
    });
    const tx = await api()
      .post('/api/v1/compliance/dnd/lookup')
      .set(auth(operator))
      .send({ phone: '+919800000099', regulatoryClass: 'TRANSACTIONAL' });
    expect(tx.body.decision.outcome).toBe('ALLOW');
  });

  it('dry-runs policy for promotional vs transactional messages without consuming caps', async () => {
    const u = await createUser(s.c);
    const promo = await api()
      .post('/api/v1/compliance/evaluate')
      .set(auth(operator))
      .send({ userId: u, eventType: 'SIPX-004' });
    expect(promo.body.regulatoryClass).toBe('PROMOTIONAL');
    expect(
      promo.body.plans.filter((p: { action: string }) => p.action === 'SUPPRESS').length,
    ).toBeGreaterThan(0);
    const tx = await api()
      .post('/api/v1/compliance/evaluate')
      .set(auth(operator))
      .send({ userId: u, eventType: 'TXNX-001' });
    expect(tx.body.plans.every((p: { action: string }) => p.action === 'QUEUE')).toBe(true);
    expect((await s.c.capper().usage(u, new Date())).global).toBe(0);
    expect((await api().get('/api/v1/compliance/decisions').set(auth(operator))).status).toBe(400);
  });
});

describe('templates', () => {
  it('lists templates for all locales and previews with sample data', async () => {
    const list = await api().get('/api/v1/templates?eventType=RISK-001').set(auth(operator));
    expect(list.body.items).toHaveLength(25); // 5 channels × 5 locales
    const p = await api()
      .post('/api/v1/templates/preview')
      .set(auth(operator))
      .send({ eventType: 'RISK-001', channel: 'sms', locale: 'hi' });
    expect(p.status).toBe(200);
    expect(p.body.locale).toBe('hi');
    expect(p.body.sms.encoding).toBe('UCS-2');
  });

  it('validates and versions templates; activation retires the previous version', async () => {
    const bad = await api().post('/api/v1/templates').set(auth(admin)).send({
      eventType: 'TXNX-001',
      channel: 'sms',
      locale: 'en',
      body: 'Hi {{{symbol}}} {{secret}}',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { message: string }) => d.message).join(' ')).toMatch(
      /triple-stash|unknown variable/,
    );
    const long = await api()
      .post('/api/v1/templates')
      .set(auth(admin))
      .send({
        eventType: 'TXNX-001',
        channel: 'sms',
        locale: 'en',
        body: `${'x'.repeat(700)} {{symbol}}`,
      });
    expect(long.status).toBe(422);
    const ok = await api().post('/api/v1/templates').set(auth(admin)).send({
      eventType: 'TXNX-001',
      channel: 'sms',
      locale: 'en',
      body: 'Bought {{quantity}} {{symbol}} @ {{currency price}}',
      activate: true,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.version.version).toBe(2);
    const versions = await api()
      .get(`/api/v1/templates/${ok.body.template.id}/versions`)
      .set(auth(operator));
    expect(versions.body.versions.map((v: { status: string }) => v.status)).toEqual([
      'ACTIVE',
      'RETIRED',
    ]);
    const back = await api()
      .post(`/api/v1/templates/${ok.body.template.id}/versions/1/activate`)
      .set(auth(admin));
    expect(back.body.activeVersion).toBe(1);
    const draft = await api()
      .post('/api/v1/templates/preview')
      .set(auth(operator))
      .send({
        eventType: 'TXNX-001',
        channel: 'push',
        draft: { title: 'T {{symbol}}', body: '{{#if (gt quantity 5)}}big{{else}}small{{/if}}' },
      });
    expect(draft.body).toMatchObject({ title: 'T INFY', body: 'big' });
  });
});

describe('template A/B testing (PDF §A4.1, Day 4)', () => {
  const smsVersionFor = async (u: string): Promise<number> => {
    const ev = await s.c.ingestion().ingest(
      {
        eventType: 'TXNX-003',
        userId: u,
        occurredAt: new Date().toISOString(),
        payload: {
          ...SAMPLE_PAYLOADS['TXNX-003'],
          orderId: `AB-${Math.random().toString(36).slice(2, 10)}`,
        },
      },
      'test',
      'corr-ab-test-0001',
    );
    await s.c.processor().process({
      eventId: ev.eventId,
      eventType: 'TXNX-003',
      userId: u,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-ab-test-0001',
      schemaVersion: 1,
    });
    const n = (await s.c.notifications().byEvent(ev.eventId)).find((x) => x.channel === 'sms')!;
    return n.template_version!;
  };

  it('splits users deterministically between variants and reports per-version rates', async () => {
    const created = await api().post('/api/v1/templates').set(auth(admin)).send({
      eventType: 'TXNX-003',
      channel: 'sms',
      locale: 'en',
      body: 'B-variant: order {{orderId}} for {{symbol}} was rejected. -Zetheta',
      activate: false,
    });
    expect(created.status).toBe(201);
    const id = created.body.template.id as string;
    const v = created.body.version.version as number;
    const start = await api()
      .post(`/api/v1/templates/${id}/experiment`)
      .set(auth(admin))
      .send({ version: v, percent: 50 });
    expect(start.body).toMatchObject({ experimentVersion: v, experimentPercent: 50 });

    const users = await Promise.all(Array.from({ length: 24 }, () => createUser(s.c)));
    const seen = await Promise.all(users.map(smsVersionFor));
    expect(new Set(seen)).toEqual(new Set([1, v])); // both variants served
    expect(await smsVersionFor(users[0]!)).toBe(seen[0]); // sticky per user

    const stats = await api()
      .get('/api/v1/analytics/template-variants?period=1d&eventType=TXNX-003')
      .set(auth(operator));
    const sms = (stats.body.data as { channel: string; templateVersion: number }[]).filter(
      (r) => r.channel === 'sms',
    );
    expect(sms.map((r) => r.templateVersion).sort()).toEqual([1, v].sort());

    await api()
      .post(`/api/v1/templates/${id}/experiment`)
      .set(auth(admin))
      .send({ version: null, percent: 0 });
    expect(await smsVersionFor(users.find((_, i) => seen[i] === v)!)).toBe(1);
  });
});

describe('provider webhooks (edges 7 and 23)', () => {
  const body = JSON.stringify({
    events: [{ id: 'evt-1', providerMessageId: 'pm-unknown', status: 'DELIVERED' }],
  });

  it('accepts correctly signed mock/email webhooks and de-duplicates by event id', async () => {
    const sig = signGeneric(s.config.WEBHOOK_SIGNING_SECRET, body, Math.floor(Date.now() / 1000));
    const r = await api()
      .post('/api/v1/webhooks/mock')
      .set('content-type', 'application/json')
      .set('x-zetheta-signature', sig)
      .send(body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: 1, unknown: 1 });
    const dup = await api()
      .post('/api/v1/webhooks/mock')
      .set('content-type', 'application/json')
      .set('x-zetheta-signature', sig)
      .send(body);
    expect(dup.body).toMatchObject({ duplicates: 1 });
  });

  it('rejects missing, wrong, tampered and stale signatures', async () => {
    const send = (sig?: string, b = body) => {
      const req = api().post('/api/v1/webhooks/email').set('content-type', 'application/json');
      return (sig ? req.set('x-zetheta-signature', sig) : req).send(b);
    };
    const now = Math.floor(Date.now() / 1000);
    expect((await send()).status).toBe(401);
    expect((await send(signGeneric('wrong-secret', body, now))).status).toBe(401);
    expect(
      (
        await send(
          signGeneric(s.config.WEBHOOK_SIGNING_SECRET, body, now),
          body.replace('DELIVERED', 'READ'),
        )
      ).status,
    ).toBe(401);
    expect(
      (await send(signGeneric(s.config.WEBHOOK_SIGNING_SECRET, body, now - 3600))).status,
    ).toBe(401);
    expect((await send('t=abc,v1=')).status).toBe(401);
  });

  it('rejects correctly signed but malformed or schema-invalid receipts (400)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const send = (body: string) =>
      api()
        .post('/api/v1/webhooks/mock')
        .set('content-type', 'application/json')
        .set('x-zetheta-signature', signGeneric(s.config.WEBHOOK_SIGNING_SECRET, body, now))
        .send(body);
    expect((await send('{not json')).status).toBe(400);
    expect((await send(JSON.stringify({ events: [{ status: 'TELEPORTED' }] }))).status).toBe(400);
  });

  it('acknowledges non-terminal Twilio statuses without changing state', async () => {
    const url = `${s.config.PUBLIC_BASE_URL}/api/v1/webhooks/twilio`;
    const params = { MessageSid: 'SM-queued-1', MessageStatus: 'queued' };
    const r = await api()
      .post('/api/v1/webhooks/twilio')
      .set('content-type', 'application/x-www-form-urlencoded')
      .set('x-twilio-signature', twilioSignature('twilio-test-token', url, params))
      .send('MessageSid=SM-queued-1&MessageStatus=queued');
    expect(r.status).toBe(200);
  });

  it('verifies Twilio, Meta and MSG91 signatures', async () => {
    const form = 'MessageSid=SM1&MessageStatus=delivered';
    const url = `${s.config.PUBLIC_BASE_URL}/api/v1/webhooks/twilio`;
    const good = twilioSignature('twilio-test-token', url, {
      MessageSid: 'SM1',
      MessageStatus: 'delivered',
    });
    expect(
      (
        await api()
          .post('/api/v1/webhooks/twilio')
          .set('content-type', 'application/x-www-form-urlencoded')
          .set('x-twilio-signature', good)
          .send(form)
      ).status,
    ).toBe(200);
    expect(
      (
        await api()
          .post('/api/v1/webhooks/twilio')
          .set('content-type', 'application/x-www-form-urlencoded')
          .set('x-twilio-signature', 'bad')
          .send(form)
      ).status,
    ).toBe(401);

    const wa = JSON.stringify({
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: 'wamid.1', status: 'read', timestamp: '1760000000' }] } },
          ],
        },
      ],
    });
    const waSig = `sha256=${hmacSha256Hex('meta-app-secret', wa)}`;
    const r = await api()
      .post('/api/v1/webhooks/whatsapp')
      .set('content-type', 'application/json')
      .set('x-hub-signature-256', waSig)
      .send(wa);
    expect(r.body).toMatchObject({ received: 1 });
    expect(
      (
        await api()
          .post('/api/v1/webhooks/whatsapp')
          .set('content-type', 'application/json')
          .set('x-hub-signature-256', 'sha256=00')
          .send(wa)
      ).status,
    ).toBe(401);
    expect(
      (
        await api().get(
          '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345',
        )
      ).text,
    ).toBe('12345');
    expect(
      (
        await api().get(
          '/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1',
        )
      ).status,
    ).toBe(401);

    const m = JSON.stringify([
      { requestId: 'REQ-1', report: [{ status: '1', date: '2026-01-01' }] },
    ]);
    expect(
      (
        await api()
          .post('/api/v1/webhooks/msg91')
          .set('content-type', 'application/json')
          .set('x-webhook-secret', 'msg91-secret')
          .send(m)
      ).status,
    ).toBe(200);
    expect(
      (
        await api()
          .post('/api/v1/webhooks/msg91')
          .set('content-type', 'application/json')
          .set('x-webhook-secret', 'nope')
          .send(m)
      ).status,
    ).toBe(401);
  });
});

describe('privacy: anonymisation and retention (edge 20)', () => {
  it('anonymises a user, scrubbing PII but keeping delivery metadata, with an audit record', async () => {
    const u = await createUser(s.c, { displayName: 'To Be Forgotten', externalRef: 'forget-me' });
    const ev = await s.c.ingestion().ingest(
      {
        eventType: 'TXNX-001',
        userId: u,
        occurredAt: new Date().toISOString(),
        payload: SAMPLE_PAYLOADS['TXNX-001']!,
      },
      'test',
      'corr-anon-001',
    );
    await s.c.processor().process({
      eventId: ev.eventId,
      eventType: 'TXNX-001',
      userId: u,
      occurredAt: '',
      correlationId: 'corr-anon-001',
      schemaVersion: 1,
    });
    const r = await api()
      .post(`/api/v1/users/${u}/anonymize`)
      .set(auth(admin))
      .send({ reason: 'DPDP erasure request' });
    expect(r.status).toBe(200);
    const user = await s.c.db()('users').where({ id: u }).first();
    expect(user).toMatchObject({ display_name: null, external_ref: null, status: 'ANONYMIZED' });
    expect(await s.c.db()('user_contacts').where({ user_id: u })).toHaveLength(0);
    const ns = await s.c.notifications().byEvent(ev.eventId);
    expect(ns.length).toBe(4);
    expect(ns.every((n) => n.content === null && n.scrubbed_at !== null)).toBe(true);
    expect((await s.c.db()('financial_events').where({ id: ev.eventId }).first()).payload).toEqual(
      {},
    );
    expect(
      (await api().get(`/api/v1/ops/audit?targetId=${u}&action=USER_ANONYMIZED`).set(auth(admin)))
        .body.items,
    ).toHaveLength(1);
    expect(
      (await api().post('/api/v1/auth/user-token').set(auth(service)).send({ userId: u })).status,
    ).toBe(404);
  });

  it('scrubs personalisation older than the retention period and keeps analytics fields', async () => {
    const u = await createUser(s.c);
    const ev = await s.c.ingestion().ingest(
      {
        eventType: 'SIPX-001',
        userId: u,
        occurredAt: new Date().toISOString(),
        payload: SAMPLE_PAYLOADS['SIPX-001']!,
      },
      'test',
      'corr-ret-0001',
    );
    await s.c.processor().process({
      eventId: ev.eventId,
      eventType: 'SIPX-001',
      userId: u,
      occurredAt: '',
      correlationId: 'corr-ret-0001',
      schemaVersion: 1,
    });
    const old = new Date(Date.now() - 91 * 86400000);
    await s.c.db()('financial_events').where({ id: ev.eventId }).update({ received_at: old });
    await s.c
      .db()
      .raw('UPDATE notifications SET created_at = ? WHERE event_id = ?', [old, ev.eventId]);
    const r = await api().post('/api/v1/ops/retention/run').set(auth(admin));
    expect(r.body.notifications).toBeGreaterThanOrEqual(2);
    const ns = await s.c.notifications().byEvent(ev.eventId);
    expect(
      ns.every((n) => n.content === null && n.scrubbed_at !== null && n.event_type === 'SIPX-001'),
    ).toBe(true);
  });
});

describe('operations endpoints', () => {
  it('reports queue statistics, providers and simulation controls', async () => {
    const q = await api().get('/api/v1/ops/queues').set(auth(operator));
    expect(q.status).toBe(200);
    expect(Object.keys(q.body.rabbitmq)).toHaveLength(6);
    const p = await api().get('/api/v1/ops/providers').set(auth(operator));
    expect(p.body.items.map((x: { name: string }) => x.name)).toEqual(
      expect.arrayContaining(['mock-sms-primary', 'socketio']),
    );
    const sim = await api()
      .post('/api/v1/ops/providers/mock-push/simulate')
      .set(auth(admin))
      .send({ mode: 'fail_transient', remaining: 1 });
    expect(sim.body).toMatchObject({ mode: 'fail_transient', remaining: 1 });
    await api()
      .post('/api/v1/ops/providers/mock-push/simulate')
      .set(auth(admin))
      .send({ mode: 'ok' });
    const upd = await api()
      .patch('/api/v1/ops/providers/mock-sms-secondary')
      .set(auth(admin))
      .send({ priority: 5, resetCircuit: true });
    expect(upd.status).toBe(200);
    expect((await api().get('/api/v1/analytics/summary').set(auth(operator))).status).toBe(200);
    expect(
      (
        await api()
          .get('/api/v1/analytics/delivery?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z')
          .set(auth(operator))
      ).status,
    ).toBe(400);
  });
});
