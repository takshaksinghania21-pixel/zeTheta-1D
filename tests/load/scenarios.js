// k6 rate-based load scenarios from PDF Day 11 (p.49–50) and §B2.1 (p.28).
// Usage: k6 run -e BASE_URL=http://localhost:3000 -e CLIENT_ID=... -e CLIENT_SECRET=... \
//          -e USER_IDS=<comma separated user ids> -e SCENARIO=<name> [-e DURATION=60s] \
//          [-e SCALE=1] tests/load/scenarios.js
// SCENARIO (arrival rate of financial EVENTS per second; each event fans out to
// one notification per selected channel):
//   normal        2 M/day   ≈  23/s   (PDF "normal load (2M messages/day)")
//   peak          10×       ≈ 231/s
//   crash         20×       ≈ 463/s
//   market_crash  §B2.1 mix over 30 min: 450 000 price alerts (MKTX-001), 28 000 margin
//                 calls (RISK-001, CRITICAL topic), 3 200 squared-off (RISK-003) ≈ 267/s
// SCALE multiplies every rate (e.g. SCALE=0.1 for a laptop smoke run). The full
// market_crash run is DURATION=30m; shorter durations keep the same mix and rate.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const USERS = (__ENV.USER_IDS || '').split(',').filter(Boolean);
const DURATION = __ENV.DURATION || '60s';
const SCALE = Number(__ENV.SCALE || 1);
const RUN = __ENV.RUN_ID || `${Date.now()}`;
const SCENARIO = __ENV.SCENARIO || 'normal';

const accepted = new Counter('events_accepted');
const rejected = new Counter('events_rejected');

const rate = (perSecond) => Math.max(1, Math.round(perSecond * SCALE));
const arrival = (exec, perSecond) => ({
  executor: 'constant-arrival-rate',
  rate: rate(perSecond),
  timeUnit: '1s',
  duration: DURATION,
  preAllocatedVUs: Math.min(500, rate(perSecond) * 2),
  maxVUs: 1000,
  exec,
});

const SCENARIOS = {
  normal: { transactions: arrival('transactions', 2000000 / 86400) },
  peak: { transactions: arrival('transactions', (10 * 2000000) / 86400) },
  crash: { transactions: arrival('transactions', (20 * 2000000) / 86400) },
  market_crash: {
    price_alerts: arrival('priceAlert', 450000 / 1800),
    margin_calls: arrival('marginCall', 28000 / 1800),
    squared_off: arrival('squaredOff', 3200 / 1800),
  },
};

export const options = {
  scenarios: SCENARIOS[SCENARIO],
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500', 'p(99)<1000'] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  if (USERS.length === 0) throw new Error('USER_IDS is required');
  if (!options.scenarios) throw new Error(`unknown SCENARIO ${SCENARIO}`);
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

function post(data, eventType, payload, i) {
  const now = new Date().toISOString();
  const res = http.post(
    `${BASE}/api/v1/events`,
    JSON.stringify({ eventType, userId: USERS[i % USERS.length], occurredAt: now, payload }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.token}` },
      tags: { name: `POST /events ${eventType}` },
    },
  );
  const ok = check(res, { accepted: (r) => r.status === 202 || r.status === 200 });
  (ok ? accepted : rejected).add(1);
}

const id = () => `${RUN}-${__VU}-${__ITER}`;
const SYMBOLS = ['SBIN', 'INFY', 'TCS', 'RELIANCE', 'HDFCBANK', 'ITC', 'LT', 'AXISBANK'];

export function transactions(data) {
  const now = new Date().toISOString();
  post(
    data,
    'TXNX-001',
    {
      orderId: `LT-${id()}`,
      symbol: 'INFY',
      exchange: 'NSE',
      quantity: 1,
      price: '1520.50',
      executedAt: now,
    },
    __VU * 100000 + __ITER,
  );
}

export function priceAlert(data) {
  const now = new Date().toISOString();
  const symbol = SYMBOLS[__ITER % SYMBOLS.length];
  post(
    data,
    'MKTX-001',
    {
      alertId: `PA-${id()}`,
      symbol,
      exchange: 'NSE',
      direction: 'BELOW',
      triggerPrice: '800',
      currentPrice: '736.00',
      triggeredAt: now,
    },
    __VU * 100000 + __ITER,
  );
}

export function marginCall(data) {
  const deadline = new Date(Date.now() + 3600000).toISOString();
  post(
    data,
    'RISK-001',
    {
      shortfallAmount: 125000,
      currentMargin: 375000,
      requiredMargin: 500000,
      deadline,
      autoSquareOffTime: deadline,
    },
    __VU * 100000 + __ITER,
  );
}

export function squaredOff(data) {
  const now = new Date().toISOString();
  post(
    data,
    'RISK-003',
    {
      orderId: `SQ-${id()}`,
      symbol: 'TATAMOTORS',
      quantity: 100,
      price: '942.10',
      realisedPnl: '-12450.50',
      reason: 'Margin shortfall not cleared',
      squaredOffAt: now,
    },
    __VU * 100000 + __ITER,
  );
}
