import { InvalidTransitionError } from '../../utils/errors';
import type { NotificationState } from '../../utils/types';

/**
 * Allowed notification lifecycle transitions.
 * Happy path: CREATED → ENRICHED → ROUTED → QUEUED → SENT → DELIVERED → READ
 */
const TRANSITIONS: Readonly<Record<NotificationState, readonly NotificationState[]>> = {
  CREATED: ['ENRICHED', 'FAILED'],
  ENRICHED: ['ROUTED', 'DND', 'SUPPRESSED', 'FAILED'],
  ROUTED: ['QUEUED', 'CAPPED', 'QUIET', 'DIGESTED', 'SUPPRESSED', 'FAILED'],
  QUIET: ['QUEUED', 'CAPPED', 'DIGESTED', 'SUPPRESSED', 'FAILED'],
  // DND: re-checked at dispatch (TRAI requires the check immediately before sending).
  QUEUED: ['SENT', 'DELIVERED', 'RETRYING', 'FAILED', 'DLQ', 'SUPPRESSED', 'BOUNCED', 'DND'],
  RETRYING: ['SENT', 'DELIVERED', 'RETRYING', 'FAILED', 'DLQ', 'SUPPRESSED', 'BOUNCED', 'DND'],
  // Receipts can arrive out of order (e.g. WhatsApp "read" before "delivered").
  SENT: ['DELIVERED', 'READ', 'FAILED', 'BOUNCED'],
  DELIVERED: ['READ', 'BOUNCED'],
  // Operator actions from the DLQ: manual retry re-queues, discard fails it.
  DLQ: ['QUEUED', 'FAILED'],
  READ: [],
  // Appendix B: capped notifications are batched into a digest or released next window.
  CAPPED: ['DIGESTED', 'QUEUED'],
  DND: [],
  FAILED: [],
  BOUNCED: [],
  SUPPRESSED: [],
  DIGESTED: [],
};

export const TERMINAL_STATES: readonly NotificationState[] = (
  Object.keys(TRANSITIONS) as NotificationState[]
).filter((s) => TRANSITIONS[s].length === 0);

export function canTransition(from: NotificationState, to: NotificationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: NotificationState, to: NotificationState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function allowedTransitions(from: NotificationState): readonly NotificationState[] {
  return TRANSITIONS[from];
}

/** Ordinal used to ignore stale/out-of-order receipts (never move backwards). */
const PROGRESS: Partial<Record<NotificationState, number>> = { SENT: 1, DELIVERED: 2, READ: 3 };
export function isForwardProgress(from: NotificationState, to: NotificationState): boolean {
  const a = PROGRESS[from];
  const b = PROGRESS[to];
  if (a === undefined || b === undefined) return true;
  return b > a;
}
