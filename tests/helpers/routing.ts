import { ManualClock } from '../../src/common/clock';
import { loadPolicy, type NotificationPolicy } from '../../src/config/policy';
import type { ConsentState } from '../../src/modules/compliance/consent';
import {
  DndService,
  InMemoryDndCache,
  type DndRegistryEntry,
  type DndRegistrySource,
} from '../../src/modules/compliance/dnd';
import { InMemoryFrequencyCapper } from '../../src/modules/frequency/frequency-capper';
import { resolvePreferences } from '../../src/modules/preferences/resolver';
import type { UserPreferences } from '../../src/modules/preferences/types';
import { InMemoryBudgetTracker } from '../../src/modules/routing/budget';
import {
  RoutingEngine,
  type ContactSummary,
  type RoutingInput,
} from '../../src/modules/routing/routing-engine';
import { EventTaxonomy } from '../../src/modules/taxonomy/taxonomy';
import { SAMPLE_PAYLOADS } from '../../src/modules/taxonomy/fixtures';
import type { Channel } from '../../src/domain/types';

export class FakeDndSource implements DndRegistrySource {
  entries = new Map<string, DndRegistryEntry>();
  snapshot: Date | null = null;
  fail = false;
  calls = 0;
  find(hash: string): Promise<DndRegistryEntry | null> {
    this.calls++;
    if (this.fail) return Promise.reject(new Error('registry down'));
    return Promise.resolve(this.entries.get(hash) ?? null);
  }
  latestSnapshotAt(): Promise<Date | null> {
    if (this.fail) return Promise.reject(new Error('registry down'));
    return Promise.resolve(this.snapshot);
  }
}

export interface Harness {
  policy: NotificationPolicy;
  taxonomy: EventTaxonomy;
  clock: ManualClock;
  dndSource: FakeDndSource;
  capper: InMemoryFrequencyCapper;
  budget: InMemoryBudgetTracker;
  unavailable: Set<Channel>;
  engine: RoutingEngine;
  input(
    code: string,
    opts?: {
      prefs?: UserPreferences;
      segment?: string;
      contacts?: ContactSummary[];
      consents?: ConsentState[];
      eventId?: string;
      status?: string;
      payload?: Record<string, unknown>;
    },
  ): RoutingInput;
}

export const ALL_CONTACTS: ContactSummary[] = [
  { channel: 'sms', status: 'ACTIVE', phoneHash: 'phone-1' },
  { channel: 'whatsapp', status: 'ACTIVE', phoneHash: 'phone-1' },
  { channel: 'email', status: 'ACTIVE' },
  { channel: 'push', status: 'ACTIVE' },
];

let seq = 0;
export function createHarness(start = '2026-01-15T06:00:00.000Z' /* 11:30 IST */): Harness {
  const policy = loadPolicy();
  const taxonomy = EventTaxonomy.load();
  const clock = new ManualClock(start);
  const dndSource = new FakeDndSource();
  dndSource.snapshot = clock.now();
  const dnd = new DndService(
    dndSource,
    new InMemoryDndCache(clock),
    { staleAfterMs: 7 * 86400000, cacheTtlSeconds: 3600 },
    clock,
  );
  const capper = new InMemoryFrequencyCapper(policy.frequencyCaps);
  const budget = new InMemoryBudgetTracker();
  const unavailable = new Set<Channel>();
  const engine = new RoutingEngine(
    policy,
    dnd,
    capper,
    budget,
    { isChannelAvailable: (c) => Promise.resolve(!unavailable.has(c)) },
    clock,
  );
  return {
    policy,
    taxonomy,
    clock,
    dndSource,
    capper,
    budget,
    unavailable,
    engine,
    input(code, opts = {}) {
      const def = taxonomy.get(code)!;
      const payload = opts.payload ?? SAMPLE_PAYLOADS[code]!;
      return {
        eventId: opts.eventId ?? `evt-${++seq}`,
        def,
        cooldownSubject: taxonomy.cooldownSubject(def, payload),
        userId: 'user-1',
        userStatus: opts.status ?? 'ACTIVE',
        preferences: resolvePreferences(policy, opts.segment ?? 'RETAIL', opts.prefs ?? {}),
        contacts: opts.contacts ?? ALL_CONTACTS,
        consents: opts.consents ?? [],
      };
    },
  };
}
