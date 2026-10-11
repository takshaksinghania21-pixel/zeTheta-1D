import type { Channel } from '../../domain/types';

export const POLICY_RULES = [
  'PREFERENCE_CHANNEL_DISABLED',
  'PREFERENCE_CATEGORY_DISABLED',
  'PREFERENCE_CHANGED_BEFORE_DISPATCH',
  'REGULATORY_MANDATORY_CHANNEL',
  'MANDATORY_UNDELIVERABLE',
  'NO_CONTACT',
  'CONTACT_INVALID',
  'CONSENT_IMPLIED',
  'CONSENT_EXPLICIT',
  'CONSENT_REVOKED',
  'PROMOTIONAL_CONSENT_REQUIRED',
  'WHATSAPP_OPT_IN_REQUIRED',
  'DND_NOT_APPLICABLE',
  'DND_NOT_REGISTERED',
  'DND_FULLY_BLOCKED',
  'DND_CATEGORY_BLOCKED',
  'DND_CATEGORY_ALLOWED',
  'DND_DATA_UNAVAILABLE',
  'QUIET_HOURS_DEFER',
  'QUIET_HOURS_BYPASS',
  'FREQUENCY_CAP_GLOBAL',
  'FREQUENCY_CAP_CHANNEL',
  'FREQUENCY_CAP_CATEGORY',
  'FREQUENCY_COOLDOWN',
  'FREQUENCY_CAP_EXEMPT',
  'BUDGET_EXHAUSTED',
  'CHANNEL_UNAVAILABLE',
  'FALLBACK_CHANNEL',
  'DIGEST_BATCHED',
  'USER_INACTIVE',
] as const;
export type PolicyRule = (typeof POLICY_RULES)[number];

export const DECISION_OUTCOMES = [
  'ALLOW',
  'BLOCK',
  'DEFER',
  'BYPASS',
  'OVERRIDE',
  'FALLBACK',
  'CAP',
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** A typed, auditable policy decision: what was decided, by which rule, and why. */
export interface PolicyDecision {
  channel: Channel | null;
  rule: PolicyRule;
  outcome: DecisionOutcome;
  explanation: string;
  metadata?: Record<string, unknown>;
}

export function decision(
  channel: Channel | null,
  rule: PolicyRule,
  outcome: DecisionOutcome,
  explanation: string,
  metadata?: Record<string, unknown>,
): PolicyDecision {
  return { channel, rule, outcome, explanation, ...(metadata ? { metadata } : {}) };
}
