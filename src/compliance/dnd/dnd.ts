import type { Clock } from '../../utils/clock';
import type { NotificationPolicy } from '../../config/policy';
import type { Channel, RegulatoryClass } from '../../utils/types';
import { decision, type PolicyDecision } from '../decisions';

export type DndStatus = 'FULLY_BLOCKED' | 'PARTIALLY_BLOCKED' | 'NOT_REGISTERED';

export interface DndRegistryEntry {
  status: DndStatus;
  blockedCategories: string[];
  registryUpdatedAt: Date;
  source: string;
}

export interface DndLookupResult {
  status: DndStatus | 'UNKNOWN';
  blockedCategories: string[];
  registryUpdatedAt: Date | null;
  source: string;
  stale: boolean;
  cached: boolean;
  error?: string;
}

/**
 * Authorised registry data source. Implementations: PostgreSQL table loaded
 * from authorised imports / test fixtures. Never scrapes public registries.
 */
export interface DndRegistrySource {
  /** Entry for a phone blind-index hash, or null when the number is absent. */
  find(phoneHash: string): Promise<DndRegistryEntry | null>;
  /** Snapshot time of the most recent complete import, or null if never loaded. */
  latestSnapshotAt(): Promise<Date | null>;
}

export interface DndCache {
  get(phoneHash: string): Promise<DndLookupResult | null>;
  set(phoneHash: string, value: DndLookupResult, ttlSeconds: number): Promise<void>;
  invalidateAll(): Promise<void>;
}

export class InMemoryDndCache implements DndCache {
  private readonly map = new Map<string, { value: DndLookupResult; expires: number }>();
  constructor(private readonly clock: Clock) {}
  get(phoneHash: string): Promise<DndLookupResult | null> {
    const hit = this.map.get(phoneHash);
    if (!hit || hit.expires <= this.clock.now().getTime()) return Promise.resolve(null);
    return Promise.resolve({ ...hit.value, cached: true });
  }
  set(phoneHash: string, value: DndLookupResult, ttlSeconds: number): Promise<void> {
    this.map.set(phoneHash, { value, expires: this.clock.now().getTime() + ttlSeconds * 1000 });
    return Promise.resolve();
  }
  invalidateAll(): Promise<void> {
    this.map.clear();
    return Promise.resolve();
  }
}

export class DndService {
  constructor(
    private readonly source: DndRegistrySource,
    private readonly cache: DndCache,
    private readonly options: { staleAfterMs: number; cacheTtlSeconds: number },
    private readonly clock: Clock,
  ) {}

  async lookup(phoneHash: string): Promise<DndLookupResult> {
    const cached = await this.cache.get(phoneHash).catch(() => null);
    if (cached) return cached;
    let result: DndLookupResult;
    try {
      const now = this.clock.now().getTime();
      const [entry, snapshot] = await Promise.all([
        this.source.find(phoneHash),
        this.source.latestSnapshotAt(),
      ]);
      if (entry) {
        result = {
          status: entry.status,
          blockedCategories: entry.blockedCategories,
          registryUpdatedAt: entry.registryUpdatedAt,
          source: entry.source,
          stale: now - entry.registryUpdatedAt.getTime() > this.options.staleAfterMs,
          cached: false,
        };
      } else if (snapshot) {
        const stale = now - snapshot.getTime() > this.options.staleAfterMs;
        result = {
          status: stale ? 'UNKNOWN' : 'NOT_REGISTERED',
          blockedCategories: [],
          registryUpdatedAt: snapshot,
          source: 'registry-snapshot',
          stale,
          cached: false,
        };
      } else {
        result = {
          status: 'UNKNOWN',
          blockedCategories: [],
          registryUpdatedAt: null,
          source: 'none',
          stale: true,
          cached: false,
          error: 'registry never loaded',
        };
      }
    } catch (err) {
      // Unavailable lookups are NOT cached so recovery is immediate.
      return {
        status: 'UNKNOWN',
        blockedCategories: [],
        registryUpdatedAt: null,
        source: 'error',
        stale: true,
        cached: false,
        error: (err as Error).message,
      };
    }
    if (this.options.cacheTtlSeconds > 0)
      await this.cache.set(phoneHash, result, this.options.cacheTtlSeconds).catch(() => undefined);
    return result;
  }
}

/** Turns a lookup result into an auditable allow/block decision. */
export function evaluateDnd(
  lookup: DndLookupResult | null,
  regulatoryClass: RegulatoryClass,
  channel: Channel,
  policy: NotificationPolicy['dnd'],
): PolicyDecision {
  if (
    !policy.appliesToClasses.includes(regulatoryClass) ||
    !policy.appliesToChannels.includes(channel)
  ) {
    return decision(
      channel,
      'DND_NOT_APPLICABLE',
      'ALLOW',
      `DND registry does not apply to ${regulatoryClass} messages on ${channel}`,
    );
  }
  const meta = lookup
    ? {
        dndStatus: lookup.status,
        registryUpdatedAt: lookup.registryUpdatedAt?.toISOString() ?? null,
        stale: lookup.stale,
        source: lookup.source,
        cached: lookup.cached,
      }
    : { dndStatus: 'UNKNOWN' };
  if (!lookup || lookup.status === 'UNKNOWN' || lookup.stale) {
    const action = policy.onStaleOrUnavailable[regulatoryClass];
    return decision(
      channel,
      'DND_DATA_UNAVAILABLE',
      action === 'BLOCK' ? 'BLOCK' : 'ALLOW',
      `DND data unavailable or stale; policy for ${regulatoryClass} is ${action}`,
      { ...meta, error: lookup?.error },
    );
  }
  if (lookup.status === 'FULLY_BLOCKED') {
    return decision(
      channel,
      'DND_FULLY_BLOCKED',
      'BLOCK',
      'Recipient is fully registered on the DND registry',
      meta,
    );
  }
  if (lookup.status === 'PARTIALLY_BLOCKED') {
    return lookup.blockedCategories.includes(policy.promotionalCategory)
      ? decision(
          channel,
          'DND_CATEGORY_BLOCKED',
          'BLOCK',
          `Recipient blocked category ${policy.promotionalCategory}`,
          meta,
        )
      : decision(
          channel,
          'DND_CATEGORY_ALLOWED',
          'ALLOW',
          `Recipient's DND preferences do not block ${policy.promotionalCategory}`,
          meta,
        );
  }
  return decision(
    channel,
    'DND_NOT_REGISTERED',
    'ALLOW',
    'Recipient is not on the DND registry',
    meta,
  );
}
