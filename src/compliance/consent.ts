import type { Channel, ConsentPurpose, RegulatoryClass } from '../utils/types';
import { decision, type PolicyDecision } from './decisions';

export type ConsentStatus = 'GRANTED' | 'REVOKED';

export interface ConsentState {
  channel: Channel;
  purpose: ConsentPurpose;
  status: ConsentStatus;
  recordedAt: Date;
  source: string;
}

/** Latest consent record per (channel, purpose). Input order does not matter. */
export function latestConsents(records: ConsentState[]): Map<string, ConsentState> {
  const map = new Map<string, ConsentState>();
  for (const r of records) {
    const key = `${r.channel}:${r.purpose}`;
    const cur = map.get(key);
    if (!cur || cur.recordedAt.getTime() <= r.recordedAt.getTime()) map.set(key, r);
  }
  return map;
}

/**
 * Consent rules (project requirements; see SECURITY.md "compliance assumptions"):
 *  - WhatsApp always needs an explicit, current opt-in for the purpose.
 *  - Promotional messages need explicit GRANTED consent on every channel except
 *    in-app (which is the user's own authenticated app session).
 *  - Transactional/service messages rely on implied consent from the account
 *    relationship, but an explicit REVOKED record is honoured.
 * Regulatory overrides do NOT bypass consent; they only bypass preferences.
 */
export function evaluateConsent(
  channel: Channel,
  regulatoryClass: RegulatoryClass,
  consents: Map<string, ConsentState>,
): PolicyDecision {
  const purpose: ConsentPurpose = regulatoryClass;
  const record = consents.get(`${channel}:${purpose}`);
  const meta = record
    ? {
        purpose,
        consentStatus: record.status,
        consentRecordedAt: record.recordedAt.toISOString(),
        consentSource: record.source,
      }
    : { purpose };
  if (channel === 'whatsapp') {
    return record?.status === 'GRANTED'
      ? decision(
          channel,
          'CONSENT_EXPLICIT',
          'ALLOW',
          `WhatsApp opt-in for ${purpose} is on record`,
          meta,
        )
      : decision(
          channel,
          'WHATSAPP_OPT_IN_REQUIRED',
          'BLOCK',
          `WhatsApp requires a separate explicit opt-in for ${purpose} messages`,
          meta,
        );
  }
  if (regulatoryClass === 'PROMOTIONAL' && channel !== 'inapp') {
    return record?.status === 'GRANTED'
      ? decision(
          channel,
          'CONSENT_EXPLICIT',
          'ALLOW',
          'Explicit promotional consent is on record',
          meta,
        )
      : decision(
          channel,
          'PROMOTIONAL_CONSENT_REQUIRED',
          'BLOCK',
          'Promotional messages require explicit opt-in consent',
          meta,
        );
  }
  if (record?.status === 'REVOKED') {
    return decision(
      channel,
      'CONSENT_REVOKED',
      'BLOCK',
      `User revoked ${purpose} consent for ${channel}`,
      meta,
    );
  }
  return record?.status === 'GRANTED'
    ? decision(
        channel,
        'CONSENT_EXPLICIT',
        'ALLOW',
        `Explicit ${purpose} consent is on record`,
        meta,
      )
    : decision(
        channel,
        'CONSENT_IMPLIED',
        'ALLOW',
        `${purpose} message relies on implied consent from the account relationship`,
        meta,
      );
}
