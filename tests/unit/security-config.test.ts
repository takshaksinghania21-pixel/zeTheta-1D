import { Writable } from 'node:stream';
import { loadConfig } from '../../src/config/env';
import {
  FieldEncryptor,
  blindIndex,
  hashSecret,
  safeEqual,
  stableStringify,
  verifySecret,
} from '../../src/common/crypto';
import { runWithContext, normaliseCorrelationId } from '../../src/common/context';
import { createLogger } from '../../src/common/logger';
import { maskEmail, maskPhone, maskToken, sanitizeForLog, scrubString } from '../../src/common/pii';
import { InMemoryRateLimiter } from '../../src/common/rate-limiter';
import { hasPermission, PERMISSIONS } from '../../src/modules/auth/permissions';
import { ROLES } from '../../src/domain/types';
import {
  signGeneric,
  verifyGeneric,
  verifyMeta,
  verifySharedSecret,
  verifyTwilio,
  twilioSignature,
} from '../../src/modules/webhooks/signatures';

const key = Buffer.alloc(32, 7).toString('base64');
const base = {
  DATABASE_URL: 'postgres://u:p@h/db',
  REDIS_URL: 'redis://h',
  RABBITMQ_URL: 'amqp://h',
  JWT_SECRET: 'x'.repeat(40),
  DATA_ENCRYPTION_KEY: key,
  DATA_HASH_KEY: Buffer.alloc(32, 8).toString('base64'),
  WEBHOOK_SIGNING_SECRET: 'w'.repeat(20),
};

describe('configuration safety', () => {
  it('applies defaults and provider lists in development', () => {
    const c = loadConfig({ ...base });
    expect(c.PROVIDER_MODE).toBe('mock');
    expect(c.SMS_PROVIDERS).toEqual(['mock-sms-primary', 'mock-sms-secondary']);
    expect(c.RATE_LIMIT_STANDARD_PER_MIN).toBe(100);
    expect(c.RATE_LIMIT_WEBHOOK_PER_MIN).toBe(1000);
    expect(c.RATE_LIMIT_PREFERENCES_PER_MIN).toBe(10);
  });

  it('rejects weak or malformed secrets', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: 'abc' })).toThrow(/32 bytes/);
  });

  it('fails closed on unsafe production configuration', () => {
    const prod = { ...base, NODE_ENV: 'production', WEBHOOK_SIGNATURE_REQUIRED: 'false' };
    expect(() => loadConfig(prod)).toThrow(/PROVIDER_MODE=mock is not allowed/);
    expect(() =>
      loadConfig({
        ...prod,
        PROVIDER_MODE: 'production',
        SMS_PROVIDERS: 'twilio',
        EMAIL_PROVIDERS: 'smtp',
        PUSH_PROVIDERS: 'fcm',
        WHATSAPP_PROVIDERS: 'whatsapp-cloud',
        JWT_SECRET: `CHANGE_ME${'x'.repeat(40)}`,
      }),
    ).toThrow(/placeholder/);
    expect(() => loadConfig({ ...prod, PROVIDER_MODE: 'production', CORS_ORIGINS: '*' })).toThrow(
      /mock providers|CORS/,
    );
    const ok = loadConfig({
      ...prod,
      PROVIDER_MODE: 'production',
      SMS_PROVIDERS: 'twilio',
      EMAIL_PROVIDERS: 'smtp',
      PUSH_PROVIDERS: 'fcm',
      WHATSAPP_PROVIDERS: 'whatsapp-cloud',
    });
    expect(ok.WEBHOOK_SIGNATURE_REQUIRED).toBe(true); // forced on
    expect(() =>
      loadConfig({
        ...prod,
        PROVIDER_MODE: 'production',
        SMS_PROVIDERS: 'twilio',
        EMAIL_PROVIDERS: 'smtp',
        PUSH_PROVIDERS: 'fcm',
        WHATSAPP_PROVIDERS: 'whatsapp-cloud',
        DATA_HASH_KEY: key,
      }),
    ).toThrow(/must differ/);
  });
});

describe('PII masking and log sanitisation', () => {
  it('masks contact values', () => {
    expect(maskPhone('+919812345678')).toBe('+********5678');
    expect(maskEmail('asha.rao@example.com')).toBe('a***@***.com');
    expect(maskToken('abcdefghijklmnop')).toBe('abcd…mnop');
  });

  it('redacts secrets, masks contacts and leaves identifiers intact', () => {
    const out = sanitizeForLog({
      password: 'p',
      authorization: 'Bearer x',
      phone: '+919812345678',
      email: 'a@b.co',
      correlationId: '12345678-1234-4123-8123-123456789012',
      nested: { note: 'call 9812345678 or mail x@y.io', token: 'secret' },
      list: [{ apiKey: 'k' }],
    }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.phone).toBe('+********5678');
    expect(out.email).toBe('a***@***.co');
    expect(out.correlationId).toBe('12345678-1234-4123-8123-123456789012');
    expect(out.nested).toEqual({
      note: 'call ******5678 or mail x***@***.io',
      token: '[REDACTED]',
    });
    expect(out.list).toEqual([{ apiKey: '[REDACTED]' }]);
    expect(scrubString('order 12345678-1234')).toBe('order 12345678-1234');
  });

  it('emits structured JSON logs with ISO timestamps, service and correlation id, never raw PII', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write: (chunk: Buffer, _e, cb) => (lines.push(chunk.toString()), cb()),
    });
    const direct = createLogger({ service: 'svc', level: 'info' }, sink);
    runWithContext({ correlationId: 'corr-log-123456' }, () =>
      direct.info({ recipient: '+919812345678', password: 'x' }, 'delivered'),
    );
    const line = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      service: 'svc',
      message: 'delivered',
      correlationId: 'corr-log-123456',
      recipient: '+********5678',
      password: '[REDACTED]',
    });
    expect(new Date(line.time as string).toISOString()).toBe(line.time);
  });

  it('normalises correlation ids', () => {
    expect(normaliseCorrelationId('abc-12345678')).toBe('abc-12345678');
    expect(normaliseCorrelationId('<bad>')).toMatch(/^[0-9a-f-]{36}$/);
    expect(normaliseCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('cryptography helpers', () => {
  it('round-trips AES-256-GCM, detects tampering and supports key rotation', () => {
    const enc = new FieldEncryptor('k1', key);
    const ct = enc.encrypt('+919812345678');
    expect(ct).not.toContain('9812345678');
    expect(enc.decrypt(ct)).toBe('+919812345678');
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same')); // random IV
    const parts = ct.split('.');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => enc.decrypt(parts.join('.'))).toThrow();
    const rotated = new FieldEncryptor('k2', Buffer.alloc(32, 9).toString('base64'), { k1: key });
    expect(rotated.decrypt(ct)).toBe('+919812345678');
    expect(rotated.encrypt('x').split('.')[1]).toBe('k2');
    expect(() => enc.decrypt('garbage')).toThrow(/Malformed/);
  });

  it('hashes passwords with scrypt and verifies in constant time', async () => {
    const h = await hashSecret('s3cret');
    expect(h).toMatch(/^scrypt\$/);
    expect(await verifySecret('s3cret', h)).toBe(true);
    expect(await verifySecret('wrong', h)).toBe(false);
    expect(await verifySecret('x', 'not-a-hash')).toBe(false);
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('produces stable blind indexes and canonical JSON', () => {
    expect(blindIndex(key, 'a')).toBe(blindIndex(key, 'a'));
    expect(blindIndex(key, 'a')).not.toBe(blindIndex(Buffer.alloc(32, 3).toString('base64'), 'a'));
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    );
  });
});

describe('webhook signature schemes', () => {
  it('generic HMAC: valid, wrong secret, tampered body, replayed timestamp, malformed', () => {
    const now = 1_760_000_000_000;
    const sig = signGeneric('secret', '{"a":1}', now / 1000);
    expect(verifyGeneric('secret', '{"a":1}', sig, 300, now)).toEqual({ valid: true });
    expect(verifyGeneric('other', '{"a":1}', sig, 300, now).valid).toBe(false);
    expect(verifyGeneric('secret', '{"a":2}', sig, 300, now).valid).toBe(false);
    expect(verifyGeneric('secret', '{"a":1}', sig, 300, now + 301_000)).toEqual({
      valid: false,
      reason: 'signature timestamp outside tolerance',
    });
    expect(verifyGeneric('secret', '{}', undefined, 300, now).valid).toBe(false);
    expect(verifyGeneric('secret', '{}', 'garbage', 300, now).valid).toBe(false);
  });

  it('Twilio, Meta and shared-secret schemes', () => {
    const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const sig = twilioSignature('tok', 'https://x.test/hook', params);
    expect(verifyTwilio('tok', 'https://x.test/hook', params, sig).valid).toBe(true);
    expect(verifyTwilio('tok', 'https://x.test/other', params, sig).valid).toBe(false);
    expect(verifyMeta('app', 'body', undefined).valid).toBe(false);
    expect(verifySharedSecret('s', 's').valid).toBe(true);
    expect(verifySharedSecret('s', undefined).valid).toBe(false);
  });
});

describe('authorisation rules (RBAC matrix)', () => {
  it('grants each role only its intended capabilities', () => {
    expect(hasPermission(['SERVICE'], 'events:ingest')).toBe(true);
    expect(hasPermission(['USER'], 'events:ingest')).toBe(false);
    expect(hasPermission(['OPERATOR'], 'dlq:retry')).toBe(true);
    expect(hasPermission(['OPERATOR'], 'dlq:discard')).toBe(false);
    expect(hasPermission(['OPERATOR'], 'users:anonymize')).toBe(false);
    expect(hasPermission(['ADMIN'], 'users:anonymize')).toBe(true);
    expect(hasPermission(['USER'], 'notifications:read:any')).toBe(false);
    expect(hasPermission(['USER', 'OPERATOR'], 'analytics:read')).toBe(true);
  });

  it('only ADMIN may perform irreversible or configuration-changing actions', () => {
    for (const p of [
      'users:anonymize',
      'dlq:discard',
      'templates:write',
      'ops:write',
      'dnd:import',
      'audit:read',
    ] as const) {
      expect(PERMISSIONS[p]).toEqual(['ADMIN']);
    }
    for (const role of ROLES) expect(hasPermission([role], 'taxonomy:read')).toBe(true);
  });
});

describe('InMemoryRateLimiter', () => {
  it('mirrors the sliding-window semantics', async () => {
    const rl = new InMemoryRateLimiter();
    const t = 6_000_000;
    for (let i = 0; i < 3; i++) expect((await rl.consume('k', 3, 60000, t + i)).allowed).toBe(true);
    expect((await rl.consume('k', 3, 60000, t + 10)).allowed).toBe(false);
    expect((await rl.peek('k', 3, 60000, t + 10)).remaining).toBe(0);
    expect((await rl.consume('k', 3, 60000, t + 119_000)).allowed).toBe(true);
  });
});
