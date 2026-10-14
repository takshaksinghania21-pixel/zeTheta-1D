import { Container } from '../../src/container';
import { ConflictError, InvalidTransitionError } from '../../src/utils/errors';
import { migrate, truncateAll } from '../helpers/db';
import { testConfig } from '../helpers/env';
import { createUser, PHONE } from '../helpers/stack';

let c: Container;
beforeAll(async () => {
  c = new Container(testConfig());
  await migrate(c.db());
});
beforeEach(() => truncateAll(c.db()));
afterAll(() => c.close());

async function newNotification(userId: string, overrides: Record<string, unknown> = {}) {
  return c.db().transaction(async (trx) =>
    c.factory().create(
      trx,
      {
        dedupeKey: `test:${Math.random()}`,
        eventId: null,
        userId,
        eventType: 'TXNX-001',
        category: 'TRANSACTION',
        channel: 'push',
        priority: 'HIGH',
        regulatoryClass: 'TRANSACTIONAL',
        locale: 'en',
        content: null,
        preferenceVersion: 1,
        correlationId: 'corr-test-0001',
        ...overrides,
      },
      'test',
    ),
  );
}

describe('PostgreSQL persistence', () => {
  it('encrypts contact details at rest and stores only masked values in clear', async () => {
    const userId = await createUser(c);
    const rows = (await c.db()('user_contacts').where({ user_id: userId })) as {
      channel: string;
      value_ciphertext: string;
      value_masked: string;
      value_hash: string;
    }[];
    const sms = rows.find((r) => r.channel === 'sms')!;
    expect(sms.value_ciphertext).not.toContain('9812345678');
    expect(sms.value_ciphertext.startsWith('v1.')).toBe(true);
    expect(sms.value_masked).toBe('+91XXXX5678');
    expect(sms.value_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await c.users().activeContact(userId, 'sms'))?.value).toBe(PHONE);
    // sms and whatsapp share a phone blind index (used for DND lookups)
    expect(rows.find((r) => r.channel === 'whatsapp')?.value_hash).toBe(sms.value_hash);
  });

  it('rejects malformed contacts', async () => {
    await expect(
      c.users().create({ contacts: [{ channel: 'sms', value: '98123' }] }),
    ).rejects.toThrow(/E.164/);
    await expect(
      c.users().create({ contacts: [{ channel: 'email', value: 'not-an-email' }] }),
    ).rejects.toThrow(/email/);
  });

  it('enforces optimistic concurrency on preferences', async () => {
    const userId = await createUser(c);
    const { version } = await c.users().getPreferences(userId);
    await c
      .users()
      .updatePreferences(userId, (p) => ({ ...p, channels: { sms: false } }), 'a', version);
    await expect(
      c.users().updatePreferences(userId, (p) => p, 'b', version),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('serialises concurrent preference writers without lost updates', async () => {
    const userId = await createUser(c);
    await Promise.all([
      c
        .users()
        .updatePreferences(userId, (p) => ({ ...p, channels: { ...p.channels, sms: false } }), 'a'),
      c
        .users()
        .updatePreferences(
          userId,
          (p) => ({ ...p, channels: { ...p.channels, email: false } }),
          'b',
        ),
    ]);
    const { preferences } = await c.users().getPreferences(userId);
    expect(preferences.channels).toEqual({ sms: false, email: false });
  });

  it('keeps an append-only consent ledger and resolves the latest state', async () => {
    const userId = await createUser(c);
    await c.consents().record({
      userId,
      channel: 'whatsapp',
      purpose: 'SERVICE',
      status: 'GRANTED',
      source: 'APP',
      recordedBy: 't',
    });
    await new Promise((r) => setTimeout(r, 5));
    await c.consents().record({
      userId,
      channel: 'whatsapp',
      purpose: 'SERVICE',
      status: 'REVOKED',
      source: 'SMS_REPLY',
      recordedBy: 't',
    });
    expect(await c.consents().history(userId)).toHaveLength(2);
    expect((await c.consents().states(userId))[0]).toMatchObject({
      status: 'REVOKED',
      source: 'SMS_REPLY',
    });
    expect((await c.db()('opt_out_events').where({ user_id: userId })).length).toBe(1);
  });

  it('stores notifications in monthly partitions', async () => {
    const userId = await createUser(c);
    const n = (await newNotification(userId))!;
    const part = await c
      .db()
      .raw('select tableoid::regclass::text as p from notifications where id = ?', [n.id]);
    expect(part.rows[0]?.p).toMatch(/^notifications_\d{4}_\d{2}$/);
    expect(await c.scheduler().maintainPartitions()).toBeGreaterThanOrEqual(0);
  });

  it('de-duplicates logical notifications by dedupe key', async () => {
    const userId = await createUser(c);
    const a = await newNotification(userId, { dedupeKey: 'evt:x:push' });
    const b = await newNotification(userId, { dedupeKey: 'evt:x:push' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('records every transition in history and the outbox atomically', async () => {
    const userId = await createUser(c);
    const n = (await newNotification(userId))!;
    await c.db().transaction(async (trx) => {
      const routed = await c.factory().advance(trx, n, ['ENRICHED', 'ROUTED'], {
        actor: 'test',
        correlationId: 'corr-test-0001',
      });
      await c.factory().queue(trx, routed, { actor: 'test', correlationId: 'corr-test-0001' });
    });
    const history = await c.notifications().history(n.id);
    expect(history.map((h) => h.to_state)).toEqual(['CREATED', 'ENRICHED', 'ROUTED', 'QUEUED']);
    expect(history.every((h) => h.correlation_id === 'corr-test-0001')).toBe(true);
    const outbox = (await c.db()('outbox')) as { destination: string; target: string }[];
    expect(outbox.filter((o) => o.destination === 'KAFKA')).toHaveLength(4); // lifecycle events
    expect(outbox.filter((o) => o.destination === 'RABBITMQ')).toHaveLength(1); // delivery message
    const stored = await c.notifications().require(n.id);
    expect(stored.state).toBe('QUEUED');
    expect(stored.queued_at).not.toBeNull();
  });

  it('rolls back the whole transition when a later step fails', async () => {
    const userId = await createUser(c);
    const n = (await newNotification(userId))!;
    await expect(
      c.db().transaction(async (trx) => {
        await c
          .lifecycle()
          .transition(trx, n, 'ENRICHED', { actor: 't', correlationId: 'corr-test-0001' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await c.notifications().require(n.id)).state).toBe('CREATED');
    expect(await c.notifications().history(n.id)).toHaveLength(1);
  });

  it('rejects invalid transitions and concurrent modifications', async () => {
    const userId = await createUser(c);
    const n = (await newNotification(userId))!;
    await expect(
      c
        .db()
        .transaction((trx) =>
          c.lifecycle().transition(trx, n, 'SENT', { actor: 't', correlationId: 'c-000000001' }),
        ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    await c
      .db()
      .transaction((trx) =>
        c.lifecycle().transition(trx, n, 'ENRICHED', { actor: 't', correlationId: 'c-000000001' }),
      );
    // `n` is now stale (state CREATED): a second writer must not overwrite
    await expect(
      c
        .db()
        .transaction((trx) =>
          c.lifecycle().transition(trx, n, 'FAILED', { actor: 't', correlationId: 'c-000000001' }),
        ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('pages notifications with a stable keyset cursor', async () => {
    const userId = await createUser(c);
    for (let i = 0; i < 5; i++) await newNotification(userId);
    const p1 = await c.notifications().list({ userId, limit: 2 });
    const p2 = await c.notifications().list({ userId, limit: 2, cursor: p1.nextCursor! });
    const p3 = await c.notifications().list({ userId, limit: 2, cursor: p2.nextCursor! });
    const ids = [...p1.items, ...p2.items, ...p3.items].map((n) => n.id);
    expect(new Set(ids).size).toBe(5);
    expect(p3.nextCursor).toBeNull();
  });

  it('refuses to truncate a non-test database (safety guard)', async () => {
    const fake = {
      raw: () => Promise.resolve({ rows: [{ n: 'zetheta' }] }),
    } as unknown as Parameters<typeof truncateAll>[0];
    await expect(truncateAll(fake)).rejects.toThrow(/refusing/);
  });
});
