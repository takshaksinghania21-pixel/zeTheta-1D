import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { EventTaxonomy } from '../../src/modules/taxonomy/taxonomy';
import { SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import { CATEGORIES } from '../../src/domain/types';

const taxonomy = EventTaxonomy.load();
const yamlPath = path.resolve(__dirname, '../../config/event-taxonomy.yaml');

function mutate(fn: (doc: { events: Record<string, unknown>[] }) => void): string {
  const doc = YAML.parse(readFileSync(yamlPath, 'utf8')) as { events: Record<string, unknown>[] };
  fn(doc);
  return YAML.stringify(doc);
}

describe('event taxonomy', () => {
  it('registers at least 25 distinct event types across all five categories', () => {
    expect(taxonomy.size).toBeGreaterThanOrEqual(25);
    const codes = taxonomy.list().map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const cat of CATEGORIES) {
      expect(taxonomy.list().filter((d) => d.category === cat)).toHaveLength(5);
    }
  });

  it('uses the assignment event codes and names', () => {
    expect(taxonomy.get('RISK-001')?.name).toBe('Margin Call Warning');
    expect(taxonomy.get('REGX-003')?.name).toBe('Contract Note Generated');
    expect(taxonomy.get('MKTX-004')?.name).toBe('52-Week High/Low');
  });

  it('accepts every synthetic sample payload', () => {
    for (const def of taxonomy.list()) {
      const res = taxonomy.validatePayload(def.code, SAMPLE_PAYLOADS[def.code]);
      expect(res).toEqual(expect.objectContaining({ ok: true }));
    }
  });

  it('rejects unknown event types', () => {
    const res = taxonomy.validatePayload('NOPE-001', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]?.code).toBe('UNKNOWN_EVENT_TYPE');
  });

  it('rejects malformed payloads with field-level errors', () => {
    const res = taxonomy.validatePayload('TXNX-001', {
      ...SAMPLE_PAYLOADS['TXNX-001'],
      quantity: -5,
      exchange: 'LSE',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const paths = res.errors.map((e) => e.path);
      expect(paths).toEqual(expect.arrayContaining(['payload.quantity', 'payload.exchange']));
    }
  });

  it('rejects missing required fields and unexpected fields', () => {
    const { orderId: _omit, ...rest } = SAMPLE_PAYLOADS['TXNX-001'] as Record<string, unknown>;
    const missing = taxonomy.validatePayload('TXNX-001', rest);
    expect(missing.ok).toBe(false);
    const extra = taxonomy.validatePayload('TXNX-001', {
      ...SAMPLE_PAYLOADS['TXNX-001'],
      hacker: true,
    });
    expect(extra.ok).toBe(false);
  });

  it('normalises decimals to strings and rejects float garbage', () => {
    const res = taxonomy.validatePayload('TXNX-005', {
      ...SAMPLE_PAYLOADS['TXNX-005'],
      amount: 1999.5,
    });
    expect(res.ok && res.payload.amount).toBe('1999.5');
    expect(
      taxonomy.validatePayload('TXNX-005', { ...SAMPLE_PAYLOADS['TXNX-005'], amount: '1e9' }).ok,
    ).toBe(false);
    expect(
      taxonomy.validatePayload('TXNX-005', { ...SAMPLE_PAYLOADS['TXNX-005'], amount: '-5' }).ok,
    ).toBe(false);
  });

  it('enforces datetime offsets, https URLs and applies defaults', () => {
    expect(
      taxonomy.validatePayload('TXNX-001', {
        ...SAMPLE_PAYLOADS['TXNX-001'],
        executedAt: '2026-01-15 09:20',
      }).ok,
    ).toBe(false);
    expect(
      taxonomy.validatePayload('REGX-003', {
        ...SAMPLE_PAYLOADS['REGX-003'],
        documentUrl: 'http://insecure.example.test/a.pdf',
      }).ok,
    ).toBe(false);
    expect(
      taxonomy.validatePayload('REGX-003', {
        ...SAMPLE_PAYLOADS['REGX-003'],
        documentUrl: 'javascript:alert(1)',
      }).ok,
    ).toBe(false);
    const res = taxonomy.validatePayload('REGX-001', {
      expiryDate: '2026-02-14',
      daysRemaining: 3,
    });
    expect(res.ok && res.payload.kycType).toBe('CKYC');
  });

  it('derives deterministic idempotency keys from declared key fields', () => {
    const k1 = taxonomy.deriveIdempotencyKey('TXNX-001', 'u1', SAMPLE_PAYLOADS['TXNX-001']!);
    const k2 = taxonomy.deriveIdempotencyKey('TXNX-001', 'u1', {
      ...SAMPLE_PAYLOADS['TXNX-001'],
      price: '1',
    });
    expect(k1).toBe('TXNX-001:u1:ORD-1001');
    expect(k2).toBe(k1);
  });

  it('scopes cooldown subjects by cooldownKeyFields', () => {
    const def = taxonomy.get('MKTX-001')!;
    expect(taxonomy.cooldownSubject(def, { symbol: 'SBIN' })).toBe('MKTX-001:SBIN');
    expect(taxonomy.cooldownSubject(taxonomy.get('SIPX-001')!, {})).toBe('SIPX-001');
  });

  it('marks only CRITICAL risk events as quiet-hours bypass', () => {
    const bypass = taxonomy
      .list()
      .filter((d) => d.quietHours === 'BYPASS')
      .map((d) => d.code);
    expect(bypass.sort()).toEqual(['RISK-001', 'RISK-002', 'RISK-003']);
  });

  describe('guard rails on taxonomy changes', () => {
    it('refuses promotional events with mandatory channels', () => {
      const text = mutate((d) => {
        const e = d.events.find((x) => x.code === 'SIPX-004')!;
        e.mandatoryChannels = ['sms'];
      });
      expect(() => EventTaxonomy.fromYaml(text)).toThrow(/promotional/);
    });
    it('refuses quiet-hours bypass for non-critical events', () => {
      const text = mutate((d) => {
        d.events.find((x) => x.code === 'TXNX-001')!.quietHours = 'BYPASS';
      });
      expect(() => EventTaxonomy.fromYaml(text)).toThrow(/CRITICAL/);
    });
    it('refuses default channels that are not permitted', () => {
      const text = mutate((d) => {
        const e = d.events.find((x) => x.code === 'MKTX-003')!;
        e.defaultChannels = ['sms'];
      });
      expect(() => EventTaxonomy.fromYaml(text)).toThrow(/defaultChannels/);
    });
    it('refuses duplicate codes and wrong prefixes', () => {
      expect(() =>
        EventTaxonomy.fromYaml(mutate((d) => d.events.push({ ...d.events[0]! }))),
      ).toThrow(/Duplicate/);
      expect(() =>
        EventTaxonomy.fromYaml(
          mutate((d) => (d.events.find((x) => x.code === 'TXNX-001')!.category = 'RISK')),
        ),
      ).toThrow(/prefix/);
    });
    it('supports adding a new event type purely through configuration', () => {
      const text = mutate((d) =>
        d.events.push({
          code: 'TXNX-006',
          name: 'Funds Withdrawn',
          category: 'TRANSACTION',
          priority: 'HIGH',
          regulatoryClass: 'TRANSACTIONAL',
          permittedChannels: ['sms', 'email'],
          defaultChannels: ['sms'],
          latencyObjectiveMs: 60000,
          quietHours: 'DEFER',
          frequencyCapExempt: true,
          idempotencyKeyFields: ['withdrawalId'],
          payload: {
            withdrawalId: { type: 'string', required: true },
            amount: { $ref: 'money', required: true },
          },
        }),
      );
      const t = EventTaxonomy.fromYaml(text);
      expect(t.get('TXNX-006')).toBeDefined();
      expect(t.validatePayload('TXNX-006', { withdrawalId: 'W1', amount: '10' }).ok).toBe(true);
    });
  });
});
