/**
 * Generates a Postman v2.1 collection from docs/openapi.json, with a pre-filled
 * auth flow (token request stores {{accessToken}}) and example bodies.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Op {
  operationId: string;
  summary?: string;
  tags?: string[];
  security?: unknown[];
  requestBody?: { content: Record<string, { schema: unknown }> };
}
const spec = JSON.parse(readFileSync('docs/openapi.json', 'utf8')) as {
  info: { title: string };
  paths: Record<string, Record<string, Op>>;
};

const examples: Record<string, unknown> = {
  issueToken: {
    grantType: 'client_credentials',
    clientId: '{{clientId}}',
    clientSecret: '{{clientSecret}}',
  },
  ingestEvent: {
    eventType: 'TXNX-001',
    userId: '{{userId}}',
    occurredAt: '2026-01-15T09:20:00+05:30',
    payload: {
      orderId: 'ORD-1001',
      symbol: 'INFY',
      exchange: 'NSE',
      quantity: 10,
      price: '1520.50',
      executedAt: '2026-01-15T09:20:00+05:30',
    },
  },
  ingestEventBatch: {
    events: [
      {
        eventType: 'SIPX-001',
        userId: '{{userId}}',
        occurredAt: '2026-01-15T09:00:00+05:30',
        payload: { sipId: 'SIP-1', fundName: 'Flexi Cap', amount: '5000', dueDate: '2026-01-20' },
      },
    ],
  },
  createUser: {
    displayName: 'Test Investor',
    locale: 'en',
    timezone: 'Asia/Kolkata',
    contacts: [
      { channel: 'email', value: 'investor@example.test' },
      { channel: 'sms', value: '+919800000099' },
    ],
  },
  updateChannelPreferences: { sms: true, push: true, email: false },
  updateQuietHours: { enabled: true, start: '22:00', end: '07:00', timezone: 'Asia/Kolkata' },
  recordConsent: {
    channel: 'whatsapp',
    purpose: 'TRANSACTIONAL',
    status: 'GRANTED',
    source: 'APP',
  },
  previewTemplate: { eventType: 'RISK-001', channel: 'sms', locale: 'hi' },
  evaluatePolicy: { userId: '{{userId}}', eventType: 'SIPX-004' },
  simulateProviderBehaviour: { mode: 'fail_transient', remaining: 3 },
  retryDeadLetter: { note: 'provider recovered' },
};

const folders = new Map<string, unknown[]>();
for (const [path, methods] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(methods)) {
    const tag = op.tags?.[0] ?? 'Other';
    const raw = `{{baseUrl}}${path.replace(/\{([^}]+)\}/g, ':$1')}`;
    const item = {
      name: op.summary ?? op.operationId,
      request: {
        method: method.toUpperCase(),
        header: [{ key: 'Content-Type', value: 'application/json' }],
        ...(op.security
          ? {
              auth: {
                type: 'bearer',
                bearer: [{ key: 'token', value: '{{accessToken}}', type: 'string' }],
              },
            }
          : { auth: { type: 'noauth' } }),
        url: {
          raw,
          host: ['{{baseUrl}}'],
          path: path
            .split('/')
            .filter(Boolean)
            .map((p) => p.replace(/\{([^}]+)\}/, ':$1')),
        },
        ...(op.requestBody
          ? {
              body: {
                mode: 'raw',
                raw: JSON.stringify(examples[op.operationId] ?? {}, null, 2),
                options: { raw: { language: 'json' } },
              },
            }
          : {}),
      },
      ...(op.operationId === 'issueToken'
        ? {
            event: [
              {
                listen: 'test',
                script: {
                  type: 'text/javascript',
                  exec: [
                    "const b = pm.response.json(); if (b.accessToken) pm.collectionVariables.set('accessToken', b.accessToken);",
                  ],
                },
              },
            ],
          }
        : {}),
    };
    folders.set(tag, [...(folders.get(tag) ?? []), item]);
  }
}

const collection = {
  info: {
    name: spec.info.title,
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description:
      'Generated from docs/openapi.json by scripts/generate-postman.ts. Run "Auth → Issue access tokens" first.',
  },
  variable: [
    { key: 'baseUrl', value: 'http://localhost:3000' },
    { key: 'clientId', value: 'trading-platform' },
    { key: 'clientSecret', value: '' },
    { key: 'accessToken', value: '' },
    { key: 'userId', value: '' },
  ],
  item: [...folders.entries()].map(([name, item]) => ({ name, item })),
};
writeFileSync(
  'docs/postman/zetheta-notification-engine.postman_collection.json',
  `${JSON.stringify(collection, null, 2)}\n`,
);
console.log(
  `Postman collection written with ${[...folders.values()].reduce((n, f) => n + f.length, 0)} requests in ${folders.size} folders`,
);
