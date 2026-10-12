// k6 load test: event ingestion throughput + end-to-end processing.
// Usage: k6 run -e BASE_URL=http://localhost:3000 -e CLIENT_ID=... -e CLIENT_SECRET=... \
//          -e USER_IDS=<comma separated synthetic user ids> [-e EVENTS=10000] [-e VUS=50] [-e BATCH=100] tests/load/ingestion.js
// Scenarios:
//   single  – EVENTS/2 events via POST /events with VUS concurrent users
//   batch   – EVENTS/2 events via POST /events/batch (BATCH per request)
// Every event is synthetic (unique order ids) and uses cap-exempt TXNX-001.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const EVENTS = Number(__ENV.EVENTS || 10000);
const VUS = Number(__ENV.VUS || 50);
const BATCH = Number(__ENV.BATCH || 100);
const USERS = (__ENV.USER_IDS || '').split(',').filter(Boolean);
const RUN = __ENV.RUN_ID || `${Date.now()}`;

const accepted = new Counter('events_accepted');
const rejected = new Counter('events_rejected');
const batchLatency = new Trend('batch_request_duration', true);

export const options = {
  scenarios: {
    single: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: Math.floor(EVENTS / 2),
      maxDuration: '10m',
      exec: 'single',
    },
    batch: {
      executor: 'shared-iterations',
      vus: Math.max(1, Math.floor(VUS / 5)),
      iterations: Math.ceil(EVENTS / 2 / BATCH),
      maxDuration: '10m',
      exec: 'batch',
    },
  },
  thresholds: {
    'http_req_failed{scenario:single}': ['rate<0.01'],
    'http_req_duration{scenario:single}': ['p(95)<500', 'p(99)<1000'],
    'http_req_failed{scenario:batch}': ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (USERS.length === 0) throw new Error('USER_IDS is required');
  const res = http.post(
    `${BASE}/api/v1/auth/token`,
    JSON.stringify({
      grantType: 'client_credentials',
      clientId: __ENV.CLIENT_ID,
      clientSecret: __ENV.CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status !== 200) throw new Error(`token request failed: ${res.status}`);
  return { token: res.json('accessToken') };
}

function event(i) {
  const now = new Date().toISOString();
  return {
    eventType: 'TXNX-001',
    userId: USERS[i % USERS.length],
    occurredAt: now,
    payload: {
      orderId: `LT-${RUN}-${i}`,
      symbol: 'INFY',
      exchange: 'NSE',
      quantity: 1 + (i % 50),
      price: '1520.50',
      executedAt: now,
    },
  };
}

export function single(data) {
  const i = __VU * 1000000 + __ITER;
  const res = http.post(`${BASE}/api/v1/events`, JSON.stringify(event(i)), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
    tags: { name: 'POST /events' },
  });
  const ok = check(res, { 'accepted 202': (r) => r.status === 202 });
  (ok ? accepted : rejected).add(1);
}

export function batch(data) {
  const base = 500000000 + __VU * 1000000 + __ITER * BATCH;
  const events = Array.from({ length: BATCH }, (_, k) => event(base + k));
  const res = http.post(`${BASE}/api/v1/events/batch`, JSON.stringify({ events }), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
    tags: { name: 'POST /events/batch' },
  });
  batchLatency.add(res.timings.duration);
  if (check(res, { 'batch 202': (r) => r.status === 202 })) {
    accepted.add(res.json('accepted'));
    rejected.add(res.json('rejected'));
  } else {
    rejected.add(BATCH);
  }
}
