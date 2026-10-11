import { ManualClock } from '../../src/common/clock';
import { loadPolicy } from '../../src/config/policy';
import {
  evaluateConsent,
  latestConsents,
  type ConsentState,
} from '../../src/modules/compliance/consent';
import { DndService, InMemoryDndCache, evaluateDnd } from '../../src/modules/compliance/dnd';
import { FakeDndSource } from '../helpers/routing';

const policy = loadPolicy();
const t = (iso: string) => new Date(iso);
function consent(
  channel: ConsentState['channel'],
  purpose: ConsentState['purpose'],
  status: ConsentState['status'],
  at = '2026-01-01T00:00:00Z',
): ConsentState {
  return { channel, purpose, status, recordedAt: t(at), source: 'test' };
}

describe('consent evaluation', () => {
  it('classifies transactional messages as allowed under implied consent', () => {
    const d = evaluateConsent('sms', 'TRANSACTIONAL', latestConsents([]));
    expect(d).toMatchObject({ outcome: 'ALLOW', rule: 'CONSENT_IMPLIED' });
  });
  it('honours an explicit revocation for transactional messages', () => {
    const d = evaluateConsent(
      'email',
      'TRANSACTIONAL',
      latestConsents([consent('email', 'TRANSACTIONAL', 'REVOKED')]),
    );
    expect(d).toMatchObject({ outcome: 'BLOCK', rule: 'CONSENT_REVOKED' });
  });
  it('blocks promotional messages without explicit consent', () => {
    expect(evaluateConsent('push', 'PROMOTIONAL', latestConsents([]))).toMatchObject({
      outcome: 'BLOCK',
      rule: 'PROMOTIONAL_CONSENT_REQUIRED',
    });
  });
  it('allows promotional messages with explicit consent', () => {
    expect(
      evaluateConsent(
        'push',
        'PROMOTIONAL',
        latestConsents([consent('push', 'PROMOTIONAL', 'GRANTED')]),
      ),
    ).toMatchObject({ outcome: 'ALLOW', rule: 'CONSENT_EXPLICIT' });
  });
  it('requires a separate WhatsApp opt-in even for transactional messages', () => {
    expect(
      evaluateConsent(
        'whatsapp',
        'TRANSACTIONAL',
        latestConsents([consent('sms', 'TRANSACTIONAL', 'GRANTED')]),
      ),
    ).toMatchObject({ outcome: 'BLOCK', rule: 'WHATSAPP_OPT_IN_REQUIRED' });
    expect(
      evaluateConsent(
        'whatsapp',
        'TRANSACTIONAL',
        latestConsents([consent('whatsapp', 'TRANSACTIONAL', 'GRANTED')]),
      ),
    ).toMatchObject({ outcome: 'ALLOW' });
  });
  it('uses the latest record when consent changes over time', () => {
    const records = [
      consent('whatsapp', 'SERVICE', 'GRANTED', '2026-01-01T00:00:00Z'),
      consent('whatsapp', 'SERVICE', 'REVOKED', '2026-01-05T00:00:00Z'),
    ];
    expect(evaluateConsent('whatsapp', 'SERVICE', latestConsents(records)).outcome).toBe('BLOCK');
    expect(
      evaluateConsent('whatsapp', 'SERVICE', latestConsents([...records].reverse())).outcome,
    ).toBe('BLOCK');
  });
  it('records consent evidence in decision metadata for auditing', () => {
    const d = evaluateConsent(
      'sms',
      'PROMOTIONAL',
      latestConsents([consent('sms', 'PROMOTIONAL', 'GRANTED')]),
    );
    expect(d.metadata).toMatchObject({
      purpose: 'PROMOTIONAL',
      consentStatus: 'GRANTED',
      consentSource: 'test',
    });
  });
});

describe('DND lookup and evaluation', () => {
  const clock = new ManualClock('2026-01-15T00:00:00Z');
  function service(src: FakeDndSource, ttl = 3600) {
    return new DndService(
      src,
      new InMemoryDndCache(clock),
      { staleAfterMs: 7 * 86400000, cacheTtlSeconds: ttl },
      clock,
    );
  }

  it('blocks promotional SMS to a fully registered number', async () => {
    const src = new FakeDndSource();
    src.snapshot = clock.now();
    src.entries.set('h1', {
      status: 'FULLY_BLOCKED',
      blockedCategories: [],
      registryUpdatedAt: clock.now(),
      source: 'fixture',
    });
    const d = evaluateDnd(await service(src).lookup('h1'), 'PROMOTIONAL', 'sms', policy.dnd);
    expect(d).toMatchObject({ outcome: 'BLOCK', rule: 'DND_FULLY_BLOCKED' });
  });

  it('does not apply DND to transactional messages', async () => {
    const src = new FakeDndSource();
    src.entries.set('h1', {
      status: 'FULLY_BLOCKED',
      blockedCategories: [],
      registryUpdatedAt: clock.now(),
      source: 'fixture',
    });
    const d = evaluateDnd(await service(src).lookup('h1'), 'TRANSACTIONAL', 'sms', policy.dnd);
    expect(d).toMatchObject({ outcome: 'ALLOW', rule: 'DND_NOT_APPLICABLE' });
  });

  it('respects partial registrations by category', async () => {
    const src = new FakeDndSource();
    src.snapshot = clock.now();
    src.entries.set('fin', {
      status: 'PARTIALLY_BLOCKED',
      blockedCategories: ['BANKING_INSURANCE_FINANCIAL'],
      registryUpdatedAt: clock.now(),
      source: 'fixture',
    });
    src.entries.set('edu', {
      status: 'PARTIALLY_BLOCKED',
      blockedCategories: ['EDUCATION'],
      registryUpdatedAt: clock.now(),
      source: 'fixture',
    });
    const svc = service(src);
    expect(evaluateDnd(await svc.lookup('fin'), 'PROMOTIONAL', 'sms', policy.dnd).rule).toBe(
      'DND_CATEGORY_BLOCKED',
    );
    expect(evaluateDnd(await svc.lookup('edu'), 'PROMOTIONAL', 'sms', policy.dnd).rule).toBe(
      'DND_CATEGORY_ALLOWED',
    );
  });

  it('treats numbers absent from a fresh snapshot as not registered', async () => {
    const src = new FakeDndSource();
    src.snapshot = clock.now();
    const r = await service(src).lookup('unknown');
    expect(r.status).toBe('NOT_REGISTERED');
    expect(evaluateDnd(r, 'PROMOTIONAL', 'sms', policy.dnd).outcome).toBe('ALLOW');
  });

  it('fails closed for promotional traffic when registry data is stale', async () => {
    const src = new FakeDndSource();
    src.snapshot = new Date('2025-12-01T00:00:00Z');
    const r = await service(src).lookup('x');
    expect(r.stale).toBe(true);
    expect(evaluateDnd(r, 'PROMOTIONAL', 'sms', policy.dnd)).toMatchObject({
      outcome: 'BLOCK',
      rule: 'DND_DATA_UNAVAILABLE',
    });
  });

  it('fails closed for promotional traffic when the registry was never loaded', async () => {
    const r = await service(new FakeDndSource()).lookup('x');
    expect(r.status).toBe('UNKNOWN');
    expect(evaluateDnd(r, 'PROMOTIONAL', 'sms', policy.dnd).outcome).toBe('BLOCK');
  });

  it('treats a stale individual entry as unknown', async () => {
    const src = new FakeDndSource();
    src.snapshot = clock.now();
    src.entries.set('old', {
      status: 'NOT_REGISTERED',
      blockedCategories: [],
      registryUpdatedAt: new Date('2025-01-01T00:00:00Z'),
      source: 'fixture',
    });
    expect(
      evaluateDnd(await service(src).lookup('old'), 'PROMOTIONAL', 'sms', policy.dnd).rule,
    ).toBe('DND_DATA_UNAVAILABLE');
  });

  it('returns UNKNOWN (and does not cache) when the lookup fails', async () => {
    const src = new FakeDndSource();
    src.snapshot = clock.now();
    src.fail = true;
    const svc = service(src);
    const r = await svc.lookup('x');
    expect(r).toMatchObject({ status: 'UNKNOWN', error: 'registry down' });
    src.fail = false;
    expect((await svc.lookup('x')).status).toBe('NOT_REGISTERED');
  });

  it('caches results and refreshes after the TTL', async () => {
    const src = new FakeDndSource();
    src.snapshot = clock.now();
    const svc = service(src, 60);
    await svc.lookup('a');
    const second = await svc.lookup('a');
    expect(second.cached).toBe(true);
    expect(src.calls).toBe(1);
    clock.advance(61_000);
    await svc.lookup('a');
    expect(src.calls).toBe(2);
  });

  it('does not apply DND to channels outside the configured set', () => {
    expect(evaluateDnd(null, 'PROMOTIONAL', 'push', policy.dnd).rule).toBe('DND_NOT_APPLICABLE');
  });
});
