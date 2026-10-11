/**
 * Functional smoke test (ARCHITECTURE.md §Verification / assignment §22E).
 * Runs against a live API + workers started with PROVIDER_MODE=mock and
 * MOCK_RECEIPT_CALLBACK_URL set. Uses seeded credentials from
 * .local/seed-credentials.json. Writes reports/smoke-test.json.
 *
 *   npm run smoke            (BASE_URL defaults to http://localhost:3000)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const creds = JSON.parse(readFileSync('.local/seed-credentials.json', 'utf8')) as {
  admin: { username: string; password: string };
  operator: { username: string; password: string };
  service: { clientId: string; clientSecret: string };
};

type Json = Record<string, unknown> & { items?: Json[] };
interface Step {
  step: number;
  name: string;
  ok: boolean;
  detail: unknown;
  ms: number;
}
const steps: Step[] = [];

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-correlation-id': `smoke-${randomUUID()}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}

async function poll<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await fn();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await fn();
  }
  return last;
}

async function step(
  n: number,
  name: string,
  fn: () => Promise<{ ok: boolean; detail: unknown }>,
): Promise<void> {
  const t = Date.now();
  try {
    const r = await fn();
    steps.push({ step: n, name, ok: r.ok, detail: r.detail, ms: Date.now() - t });
  } catch (err) {
    steps.push({ step: n, name, ok: false, detail: String(err), ms: Date.now() - t });
  }
  const s = steps[steps.length - 1]!;
  console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${String(n).padStart(2)}. ${name} (${s.ms} ms)`);
  if (!s.ok) console.log('      ', JSON.stringify(s.detail).slice(0, 600));
}

async function token(body: unknown): Promise<string> {
  const r = await call('POST', '/api/v1/auth/token', undefined, body);
  if (r.status !== 200) throw new Error(`token request failed: ${r.status}`);
  return r.body.accessToken as string;
}

async function main(): Promise<void> {
  const service = await token({
    grantType: 'client_credentials',
    clientId: creds.service.clientId,
    clientSecret: creds.service.clientSecret,
  });
  const admin = await token({
    grantType: 'password',
    username: creds.admin.username,
    password: creds.admin.password,
  });
  const operator = await token({
    grantType: 'password',
    username: creds.operator.username,
    password: creds.operator.password,
  });
  const run = randomUUID().slice(0, 8);
  let userId = '';
  let eventId = '';
  let firstEvent: unknown;
  const ev = (orderId: string) => ({
    eventType: 'TXNX-001',
    userId,
    occurredAt: new Date().toISOString(),
    payload: {
      orderId,
      symbol: 'INFY',
      exchange: 'NSE',
      quantity: 10,
      price: '1520.50',
      executedAt: new Date().toISOString(),
    },
  });
  const eventStatus = (id: string) => call('GET', `/api/v1/events/${id}`, operator);

  await step(1, 'Create a synthetic test user', async () => {
    const r = await call('POST', '/api/v1/users', service, {
      externalRef: `smoke-${run}`,
      displayName: 'Smoke Tester',
      locale: 'en',
      timezone: 'UTC',
      contacts: [
        { channel: 'sms', value: '+919811111111' },
        { channel: 'email', value: `smoke-${run}@example.test` },
        { channel: 'push', value: `fcm-smoke-token-${run}-00000000000` },
      ],
    });
    userId = r.body.id as string;
    return { ok: r.status === 201 && Boolean(userId), detail: { status: r.status, userId } };
  });

  await step(2, 'Configure preferences (quiet hours off, push+email+in-app)', async () => {
    const a = await call('PUT', `/api/v1/users/${userId}/preferences/quiet-hours`, service, {
      enabled: false,
      start: '22:00',
      end: '07:00',
      timezone: 'UTC',
    });
    const b = await call('PUT', `/api/v1/users/${userId}/preferences/channels`, service, {
      sms: false,
      push: true,
      email: true,
      inapp: true,
    });
    const eff = b.body.effective as
      | { channels: Record<string, boolean>; quietHours: { enabled: boolean } }
      | undefined;
    return {
      ok:
        a.status === 200 &&
        b.status === 200 &&
        eff?.channels.sms === false &&
        !eff.quietHours.enabled,
      detail: { version: b.body.version, sources: (b.body.effective as Json | undefined)?.sources },
    };
  });

  await step(3, 'Submit a valid financial event (202 Accepted)', async () => {
    firstEvent = ev(`SMOKE-${run}-1`);
    const r = await call('POST', '/api/v1/events', service, firstEvent);
    eventId = r.body.eventId as string;
    return { ok: r.status === 202 && r.body.status === 'ACCEPTED', detail: r.body };
  });

  let status: { status: number; body: Json } = { status: 0, body: {} };
  await step(4, 'Event processed asynchronously (Kafka → consumer)', async () => {
    status = await poll(
      () => eventStatus(eventId),
      (r) => r.body.status === 'PROCESSED',
      20000,
    );
    return {
      ok: status.body.status === 'PROCESSED',
      detail: {
        status: status.body.status,
        notifications: (status.body.notifications as Json[]).length,
      },
    };
  });

  await step(5, 'Routing and compliance decisions recorded', async () => {
    const decisions = status.body.decisions as {
      rule: string;
      channel: string | null;
      outcome: string;
    }[];
    const rules = decisions.map((d) => `${d.channel ?? '-'}:${d.rule}:${d.outcome}`);
    const dry = await call('POST', '/api/v1/compliance/evaluate', operator, {
      userId,
      eventType: 'SIPX-004',
    });
    const promo = (dry.body.decisions as { rule: string }[]).map((d) => d.rule);
    return {
      ok:
        ['push', 'email', 'inapp'].every((ch) => rules.includes(`${ch}:CONSENT_IMPLIED:ALLOW`)) &&
        rules.includes('-:FREQUENCY_CAP_EXEMPT:ALLOW') &&
        promo.includes('PROMOTIONAL_CONSENT_REQUIRED'),
      detail: { transactional: rules, promotionalDryRun: promo },
    };
  });

  await step(6, 'Templates rendered per channel', async () => {
    const ns = status.body.notifications as {
      channel: string;
      title: string | null;
      body: string | null;
    }[];
    return {
      ok: ns.length === 3 && ns.every((n) => n.body?.includes('INFY')),
      detail: ns.map((n) => `${n.channel}: ${n.title}`),
    };
  });

  let delivered: { status: number; body: Json } = { status: 0, body: {} };
  await step(7, 'Mock providers received the delivery requests (SENT)', async () => {
    delivered = await poll(
      () => eventStatus(eventId),
      (r) =>
        (r.body.notifications as { state: string }[]).every((n) =>
          ['SENT', 'DELIVERED'].includes(n.state),
        ),
      20000,
    );
    const states = (
      delivered.body.notifications as { channel: string; state: string; provider: string }[]
    ).map((n) => `${n.channel}:${n.state}:${n.provider}`);
    return {
      ok: (delivered.body.notifications as { state: string }[]).every((n) =>
        ['SENT', 'DELIVERED'].includes(n.state),
      ),
      detail: states,
    };
  });

  await step(8, 'Delivery status persisted (receipts → DELIVERED via signed webhook)', async () => {
    delivered = await poll(
      () => eventStatus(eventId),
      (r) =>
        (r.body.notifications as { channel: string; state: string }[])
          .filter((n) => n.channel !== 'inapp')
          .every((n) => n.state === 'DELIVERED'),
      15000,
    );
    const ns = delivered.body.notifications as { id: string; channel: string; state: string }[];
    const push = ns.find((n) => n.channel === 'push')!;
    const d = await call('GET', `/api/v1/deliveries/${push.id}/status`, operator);
    return {
      ok:
        ns.filter((n) => n.channel !== 'inapp').every((n) => n.state === 'DELIVERED') &&
        d.status === 200,
      detail: { states: ns.map((n) => `${n.channel}:${n.state}`), delivery: d.body },
    };
  });

  await step(9, 'State history recorded', async () => {
    const push = (delivered.body.notifications as { id: string; channel: string }[]).find(
      (n) => n.channel === 'push',
    )!;
    const h = await call('GET', `/api/v1/notifications/${push.id}/history`, operator);
    const path = (h.body.items as { toState: string }[]).map((x) => x.toState);
    return {
      ok: path.join('>') === 'CREATED>ENRICHED>ROUTED>QUEUED>SENT>DELIVERED',
      detail: path.join(' > '),
    };
  });

  let failingEvent = '';
  await step(10, 'Simulate a provider failure (mock-push: 2 transient failures)', async () => {
    const r = await call('POST', '/api/v1/ops/providers/mock-push/simulate', admin, {
      mode: 'fail_transient',
      remaining: 2,
    });
    const e = await call('POST', '/api/v1/events', service, ev(`SMOKE-${run}-2`));
    failingEvent = e.body.eventId as string;
    return { ok: r.status === 200 && e.status === 202, detail: { simulate: r.body } };
  });

  await step(11, 'Retry with backoff recovers the delivery', async () => {
    const s = await poll(
      () => eventStatus(failingEvent),
      (r) =>
        (r.body.notifications as { channel: string; state: string }[] | undefined)?.find(
          (n) => n.channel === 'push',
        )?.state === 'DELIVERED',
      30000,
    );
    const push = (
      s.body.notifications as { id: string; channel: string; state: string; retryCount: number }[]
    ).find((n) => n.channel === 'push')!;
    const attempts = await call('GET', `/api/v1/notifications/${push.id}/attempts`, operator);
    const hist = await call('GET', `/api/v1/notifications/${push.id}/history`, operator);
    return {
      ok:
        push.state === 'DELIVERED' &&
        push.retryCount === 2 &&
        (attempts.body.items as { status: string }[]).filter((a) => a.status === 'FAILED')
          .length === 2,
      detail: {
        retryCount: push.retryCount,
        attempts: (attempts.body.items as { status: string; errorCode: string | null }[]).map(
          (a) => `${a.status}:${a.errorCode ?? ''}`,
        ),
        history: (hist.body.items as { toState: string }[]).map((x) => x.toState).join('>'),
      },
    };
  });

  let dlqId = '';
  let exhaustedEvent = '';
  await step(
    12,
    'Exhaust retries → DLQ (mock-email failing permanently-transient, HIGH: 5 retries)',
    async () => {
      await call('POST', '/api/v1/ops/providers/mock-email/simulate', admin, {
        mode: 'fail_transient',
        remaining: null,
      });
      const e = await call('POST', '/api/v1/events', service, ev(`SMOKE-${run}-3`));
      exhaustedEvent = e.body.eventId as string;
      const s = await poll(
        () => eventStatus(exhaustedEvent),
        (r) =>
          (r.body.notifications as { channel: string; state: string }[] | undefined)?.find(
            (n) => n.channel === 'email',
          )?.state === 'DLQ',
        90000,
        1000,
      );
      const email = (
        s.body.notifications as { id: string; channel: string; state: string; retryCount: number }[]
      ).find((n) => n.channel === 'email')!;
      const dlq = await call('GET', '/api/v1/dlq?status=OPEN&channel=email&limit=50', operator);
      const entry = (
        dlq.body.items as { id: string; notificationId: string; reasonCode: string }[]
      ).find((x) => x.notificationId === email.id);
      dlqId = entry?.id ?? '';
      await call('POST', '/api/v1/ops/providers/mock-email/simulate', admin, {
        mode: 'ok',
        remaining: null,
      });
      return {
        ok: email.state === 'DLQ' && email.retryCount === 5 && Boolean(entry),
        detail: { state: email.state, retryCount: email.retryCount, dlq: entry },
      };
    },
  );

  await step(
    13,
    'Authorised DLQ retry (operator) re-delivers; unauthorised discard rejected',
    async () => {
      const forbidden = await call('POST', `/api/v1/dlq/${dlqId}/resolve`, operator, {
        resolution: 'DISCARDED',
        note: 'should be denied',
      });
      const r = await call('POST', `/api/v1/dlq/${dlqId}/retry`, operator, {
        note: 'provider recovered',
      });
      // The provider's circuit is still open from step 12; the retry waits for the half-open trial.
      const s = await poll(
        () => eventStatus(exhaustedEvent),
        (x) =>
          ['SENT', 'DELIVERED'].includes(
            (x.body.notifications as { channel: string; state: string }[]).find(
              (n) => n.channel === 'email',
            )?.state ?? '',
          ),
        60000,
        1000,
      );
      const email = (s.body.notifications as { channel: string; state: string }[]).find(
        (n) => n.channel === 'email',
      )!;
      return {
        ok:
          forbidden.status === 403 &&
          r.status === 200 &&
          r.body.status === 'RETRIED' &&
          ['SENT', 'DELIVERED'].includes(email.state),
        detail: {
          discardAsOperator: forbidden.status,
          retry: r.body.status,
          finalState: email.state,
        },
      };
    },
  );

  await step(14, 'Analytics reflect the run (sent, delivered, retries, DLQ)', async () => {
    const a = await poll(
      () => call('GET', '/api/v1/analytics/delivery?groupBy=channel', operator),
      (r) =>
        ((r.body.data as { channel: string; retries: number }[] | undefined) ?? []).some(
          (x) => x.channel === 'email' && x.retries >= 5,
        ),
      30000,
      1000,
    );
    const lat = await call('GET', '/api/v1/analytics/latency', operator);
    const rows = a.body.data as {
      channel: string;
      sent: number;
      delivered: number;
      retries: number;
      dlq: number;
    }[];
    const email = rows.find((x) => x.channel === 'email');
    return {
      ok: Boolean(email && email.retries >= 5 && email.dlq >= 1 && email.sent >= 1),
      detail: { delivery: rows, latency: lat.body.data },
    };
  });

  await step(15, 'Duplicate submission does not create duplicate notifications', async () => {
    const before = await call(
      'GET',
      `/api/v1/notifications?eventId=${eventId}&limit=100`,
      operator,
    );
    const dup = await call('POST', '/api/v1/events', service, firstEvent);
    const conflict = await call('POST', '/api/v1/events', service, ev(`SMOKE-${run}-1`)); // same key, different payload
    await new Promise((r) => setTimeout(r, 1500));
    const after = await call('GET', `/api/v1/notifications?eventId=${eventId}&limit=100`, operator);
    return {
      ok:
        dup.status === 200 &&
        dup.body.status === 'DUPLICATE' &&
        dup.body.eventId === eventId &&
        conflict.status === 409 &&
        (before.body.items ?? []).length === (after.body.items ?? []).length,
      detail: {
        duplicate: dup.status,
        conflictingPayload: conflict.status,
        before: (before.body.items ?? []).length,
        after: (after.body.items ?? []).length,
      },
    };
  });

  const passed = steps.filter((s) => s.ok).length;
  const report = {
    runAt: new Date().toISOString(),
    baseUrl: BASE,
    passed,
    failed: steps.length - passed,
    steps,
  };
  writeFileSync('reports/smoke-test.json', JSON.stringify(report, null, 2));
  console.log(`\n${passed}/${steps.length} smoke steps passed — report: reports/smoke-test.json`);
  process.exit(passed === steps.length ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
