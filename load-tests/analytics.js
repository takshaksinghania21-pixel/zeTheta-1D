// k6: analytics/query latency under concurrent operators.
// Usage: k6 run -e BASE_URL=... -e USERNAME=operator -e PASSWORD=... [-e VUS=10 -e DURATION=30s] load-tests/analytics.js
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
export const options = {
  vus: Number(__ENV.VUS || 10),
  duration: __ENV.DURATION || '30s',
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<1000'] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const res = http.post(
    `${BASE}/api/v1/auth/token`,
    JSON.stringify({ grantType: 'password', username: __ENV.USERNAME, password: __ENV.PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { token: res.json('accessToken') };
}

const paths = [
  '/api/v1/analytics/summary',
  '/api/v1/analytics/latency',
  '/api/v1/analytics/delivery?groupBy=eventType',
  '/api/v1/notifications?limit=50',
  '/api/v1/ops/queues',
];

export default function (data) {
  const p = paths[__ITER % paths.length];
  const res = http.get(`${BASE}${p}`, {
    headers: { Authorization: `Bearer ${data.token}` },
    tags: { name: p.split('?')[0] },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
