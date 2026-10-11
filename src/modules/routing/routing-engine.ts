import type { Clock } from '../../common/clock';
import type { NotificationPolicy } from '../../config/policy';
import type { Channel } from '../../domain/types';
import { evaluateConsent, latestConsents, type ConsentState } from '../compliance/consent';
import { decision, type PolicyDecision } from '../compliance/decisions';
import { evaluateDnd, type DndService } from '../compliance/dnd';
import type { FrequencyCapper, CapScope } from '../frequency/frequency-capper';
import { channelsForEvent } from '../preferences/resolver';
import type { EffectivePreferences } from '../preferences/types';
import { evaluateQuietHours, nextDigestTime } from '../scheduling/quiet-hours';
import type { EventDefinition } from '../taxonomy/taxonomy';
import type { BudgetTracker } from './budget';

export interface ContactSummary {
  channel: Channel;
  status: 'ACTIVE' | 'INVALID';
  /** Blind index of the phone number (sms/whatsapp) for DND lookups. */
  phoneHash?: string;
}

export interface ChannelHealth {
  /** True when at least one enabled provider for the channel can take traffic. */
  isChannelAvailable(channel: Channel): Promise<boolean>;
}

export interface RoutingInput {
  eventId: string;
  def: EventDefinition;
  cooldownSubject: string;
  userId: string;
  userStatus: string;
  preferences: EffectivePreferences;
  contacts: ContactSummary[];
  consents: ConsentState[];
}

export type ChannelAction = 'QUEUE' | 'DEFER' | 'DIGEST' | 'DND' | 'SUPPRESS' | 'CAP';

export interface ChannelPlan {
  channel: Channel;
  action: ChannelAction;
  /** Added by a regulatory mandatory-channel override. */
  viaOverride: boolean;
  /** Channel this plan replaces (fallback), if any. */
  fallbackFor?: Channel;
  /** DEFER: quiet window end; DIGEST: next digest instant. */
  releaseAt?: Date;
  reason?: string;
  quietBypassed?: boolean;
}

export interface RoutingPlan {
  plans: ChannelPlan[];
  decisions: PolicyDecision[];
  capHit: boolean;
}

const CAP_RULES: Record<CapScope, PolicyDecision['rule']> = {
  GLOBAL: 'FREQUENCY_CAP_GLOBAL',
  CHANNEL: 'FREQUENCY_CAP_CHANNEL',
  CATEGORY: 'FREQUENCY_CAP_CATEGORY',
  COOLDOWN: 'FREQUENCY_COOLDOWN',
};

type Evaluation = { plan: ChannelPlan } | { fallback: true; reason: string };

/**
 * Applies, per candidate channel and in this order:
 *   preferences (+ regulatory overrides) → contact availability → consent → DND →
 *   cost budget → provider availability → digest batching → quiet hours,
 * then frequency caps across the channels that would be sent now.
 * Fallback channels are tried only for *technical* unavailability (no contact,
 * channel/provider down, budget) — never to route around a user's consent, DND
 * registration or preference, which would defeat the user's choice.
 */
export class RoutingEngine {
  constructor(
    private readonly policy: NotificationPolicy,
    private readonly dnd: DndService,
    private readonly capper: FrequencyCapper,
    private readonly budget: BudgetTracker,
    private readonly health: ChannelHealth,
    private readonly clock: Clock,
  ) {}

  /** `dryRun` evaluates every rule without consuming frequency-cap budget. */
  async route(input: RoutingInput, options: { dryRun?: boolean } = {}): Promise<RoutingPlan> {
    const { def, preferences } = input;
    const decisions: PolicyDecision[] = [];
    const now = this.clock.now();

    if (input.userStatus !== 'ACTIVE') {
      decisions.push(
        decision(null, 'USER_INACTIVE', 'BLOCK', `User status is ${input.userStatus}`),
      );
      return { plans: [], decisions, capHit: false };
    }

    const selection = channelsForEvent(def, preferences);
    for (const c of selection.disabledByUser) {
      decisions.push(
        selection.categoryDisabled
          ? decision(
              c,
              'PREFERENCE_CATEGORY_DISABLED',
              'BLOCK',
              `User disabled ${def.category} notifications`,
            )
          : decision(c, 'PREFERENCE_CHANNEL_DISABLED', 'BLOCK', `User disabled the ${c} channel`),
      );
    }
    for (const c of selection.overridden) {
      decisions.push(
        decision(
          c,
          'REGULATORY_MANDATORY_CHANNEL',
          'OVERRIDE',
          `${def.code} is mandatory on ${c}; user preference overridden`,
          {
            event: def.code,
            mandatoryChannels: def.mandatoryChannels,
          },
        ),
      );
    }

    const consents = latestConsents(input.consents);
    const selected = new Set<Channel>([...selection.preferred, ...selection.overridden]);
    const plans: ChannelPlan[] = [];

    const tryFallback = async (failed: Channel, reason: string): Promise<boolean> => {
      for (const f of def.fallbackChannels) {
        if (selected.has(f) || !def.permittedChannels.includes(f)) continue;
        if (!preferences.channels[f] || !preferences.categories[def.category].enabled) continue;
        selected.add(f);
        const ev = await this.evaluate(f, false, input, consents, decisions, now);
        if ('plan' in ev) {
          ev.plan.fallbackFor = failed;
          plans.push(ev.plan);
          decisions.push(
            decision(
              f,
              'FALLBACK_CHANNEL',
              'FALLBACK',
              `${failed} unavailable (${reason}); falling back to ${f}`,
            ),
          );
          return true;
        }
      }
      return false;
    };

    const candidates: [Channel, boolean][] = [
      ...selection.preferred.map((c): [Channel, boolean] => [c, false]),
      ...selection.overridden.map((c): [Channel, boolean] => [c, true]),
    ];
    for (const [channel, override] of candidates) {
      const ev = await this.evaluate(channel, override, input, consents, decisions, now);
      if ('plan' in ev) plans.push(ev.plan);
      else await tryFallback(channel, ev.reason);
    }

    // Frequency caps apply to everything that would go out now.
    let capHit = false;
    const sendNow = plans.filter((p) => p.action === 'QUEUE');
    if (sendNow.length > 0) {
      const result = await this.capper.checkAndConsume({
        userId: input.userId,
        eventRef: input.eventId,
        category: def.category,
        cooldownSubject: input.cooldownSubject,
        channels: sendNow.map((p) => p.channel),
        exempt: def.frequencyCapExempt,
        now,
        ...(options.dryRun ? { dryRun: true } : {}),
      });
      if (def.frequencyCapExempt) {
        decisions.push(
          decision(
            null,
            'FREQUENCY_CAP_EXEMPT',
            'ALLOW',
            `${def.code} is exempt from frequency caps (counted, never blocked)`,
          ),
        );
      }
      for (const b of result.blocked) {
        const plan = sendNow.find((p) => p.channel === b.channel);
        if (!plan) continue;
        plan.action = 'CAP';
        plan.reason = CAP_RULES[b.scope];
        capHit = true;
        decisions.push(
          decision(
            b.channel,
            CAP_RULES[b.scope],
            'CAP',
            `Frequency cap (${b.scope.toLowerCase()}) reached`,
          ),
        );
      }
    }

    if (def.mandatoryChannels.length > 0) {
      const delivering = plans.some(
        (p) => def.mandatoryChannels.includes(p.channel) && ['QUEUE', 'DEFER'].includes(p.action),
      );
      if (!delivering) {
        decisions.push(
          decision(
            null,
            'MANDATORY_UNDELIVERABLE',
            'BLOCK',
            'No mandatory channel could be used; escalate to operations',
            {
              mandatoryChannels: def.mandatoryChannels,
            },
          ),
        );
      }
    }
    return { plans, decisions, capHit };
  }

  private async evaluate(
    channel: Channel,
    override: boolean,
    input: RoutingInput,
    consents: ReturnType<typeof latestConsents>,
    decisions: PolicyDecision[],
    now: Date,
  ): Promise<Evaluation> {
    const { def, preferences } = input;
    const base = { channel, viaOverride: override };

    // 1. Contact availability (in-app needs none).
    if (channel !== 'inapp') {
      const contact = input.contacts.find((c) => c.channel === channel && c.status === 'ACTIVE');
      if (!contact) {
        const invalid = input.contacts.some((c) => c.channel === channel && c.status === 'INVALID');
        decisions.push(
          invalid
            ? decision(channel, 'CONTACT_INVALID', 'BLOCK', `${channel} contact is marked invalid`)
            : decision(channel, 'NO_CONTACT', 'BLOCK', `No ${channel} contact on file`),
        );
        return { fallback: true, reason: invalid ? 'contact invalid' : 'no contact' };
      }
    }

    // 2. Consent.
    const consent = evaluateConsent(channel, def.regulatoryClass, consents);
    decisions.push(consent);
    if (consent.outcome === 'BLOCK')
      return { plan: { ...base, action: 'SUPPRESS', reason: consent.rule } };

    // 3. DND registry.
    if (
      this.policy.dnd.appliesToChannels.includes(channel) &&
      this.policy.dnd.appliesToClasses.includes(def.regulatoryClass)
    ) {
      const phoneHash = input.contacts.find(
        (c) => c.channel === channel && c.status === 'ACTIVE',
      )?.phoneHash;
      const lookup = phoneHash ? await this.dnd.lookup(phoneHash) : null;
      const d = evaluateDnd(lookup, def.regulatoryClass, channel, this.policy.dnd);
      decisions.push(d);
      if (d.outcome === 'BLOCK') return { plan: { ...base, action: 'DND', reason: d.rule } };
    }

    // 4. Cost budget.
    const budget = this.policy.costs.dailyBudgetMicros[channel];
    if (budget !== undefined && !this.policy.costs.budgetExemptPriorities.includes(def.priority)) {
      const spent = await this.budget.spent(channel, now);
      if (spent + this.policy.costs.perMessageMicros[channel] > budget) {
        decisions.push(
          decision(channel, 'BUDGET_EXHAUSTED', 'BLOCK', `Daily ${channel} budget exhausted`, {
            spentMicros: spent,
            budgetMicros: budget,
          }),
        );
        return { fallback: true, reason: 'budget exhausted' };
      }
    }

    // 5. Provider availability (circuit breakers / disabled providers).
    if (!(await this.health.isChannelAvailable(channel))) {
      const hasFallback = def.fallbackChannels.some(
        (f) => f !== channel && preferences.channels[f],
      );
      decisions.push(
        decision(
          channel,
          'CHANNEL_UNAVAILABLE',
          hasFallback ? 'BLOCK' : 'ALLOW',
          hasFallback
            ? `No healthy ${channel} provider; trying fallback`
            : `No healthy ${channel} provider; queued for retry`,
        ),
      );
      if (hasFallback && !override) return { fallback: true, reason: 'no healthy provider' };
    }

    // 6. Digest batching for low-priority categories the user digests.
    const digest = preferences.digest;
    if (
      digest.enabled &&
      def.priority === 'LOW' &&
      digest.categories.includes(def.category) &&
      channel !== 'inapp' &&
      !override
    ) {
      const releaseAt = nextDigestTime(
        now,
        preferences.timezone,
        digest.deliveryTime,
        digest.frequency,
      );
      decisions.push(
        decision(
          channel,
          'DIGEST_BATCHED',
          'DEFER',
          `Batched into ${digest.frequency.toLowerCase()} digest`,
          { releaseAt: releaseAt.toISOString() },
        ),
      );
      return { plan: { ...base, action: 'DIGEST', releaseAt } };
    }

    // 7. Quiet hours (intrusive channels only).
    if (this.policy.quietHours.appliesToChannels.includes(channel)) {
      const q = evaluateQuietHours(now, preferences.timezone, preferences.quietHours);
      if (q.inQuietHours) {
        const meta = {
          timezone: preferences.timezone,
          localTime: q.localTime,
          window: `${preferences.quietHours.start}-${preferences.quietHours.end}`,
        };
        if (def.quietHours === 'BYPASS') {
          decisions.push(
            decision(
              channel,
              'QUIET_HOURS_BYPASS',
              'BYPASS',
              `${def.priority} event ${def.code} is authorised to bypass quiet hours`,
              meta,
            ),
          );
          return { plan: { ...base, action: 'QUEUE', quietBypassed: true } };
        }
        decisions.push(
          decision(channel, 'QUIET_HOURS_DEFER', 'DEFER', 'Deferred until quiet hours end', {
            ...meta,
            releaseAt: q.endsAt?.toISOString(),
          }),
        );
        return { plan: { ...base, action: 'DEFER', ...(q.endsAt ? { releaseAt: q.endsAt } : {}) } };
      }
    }

    return { plan: { ...base, action: 'QUEUE' } };
  }
}
