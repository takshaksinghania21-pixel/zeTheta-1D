import { DateTime } from 'luxon';
import { toMinutes } from '../../config/policy';
import type { DigestFrequency } from '../../utils/types';

export interface QuietWindow {
  enabled: boolean;
  start: string;
  end: string;
}

/** Wall-clock length of a quiet window in minutes (handles windows crossing midnight). */
export function quietWindowMinutes(start: string, end: string): number {
  return (toMinutes(end) - toMinutes(start) + 1440) % 1440;
}

/** Returns an error message if the window violates the minimum length, else null. */
export function validateQuietWindow(w: QuietWindow, minimumMinutes: number): string | null {
  if (!w.enabled) return null;
  if (w.start === w.end) return 'quiet hours start and end must differ';
  const len = quietWindowMinutes(w.start, w.end);
  if (len < minimumMinutes) {
    return `quiet hours must span at least ${minimumMinutes / 60} hours (got ${(len / 60).toFixed(2)})`;
  }
  return null;
}

export interface QuietEvaluation {
  inQuietHours: boolean;
  /** UTC instant at which the current quiet window ends (only when inQuietHours). */
  endsAt?: Date;
  localTime: string;
}

/**
 * Evaluates quiet hours in the user's IANA timezone. All arithmetic is done on
 * local wall-clock time via Luxon, so DST transitions are handled: if the end
 * time falls in a spring-forward gap, Luxon moves it to the first valid instant.
 */
export function evaluateQuietHours(now: Date, timezone: string, w: QuietWindow): QuietEvaluation {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  const zoned = local.isValid ? local : DateTime.fromJSDate(now, { zone: 'UTC' });
  const localTime = zoned.toFormat('HH:mm');
  if (!w.enabled || w.start === w.end) return { inQuietHours: false, localTime };
  const m = zoned.hour * 60 + zoned.minute;
  const s = toMinutes(w.start);
  const e = toMinutes(w.end);
  const crossesMidnight = s > e;
  const inQuiet = crossesMidnight ? m >= s || m < e : m >= s && m < e;
  if (!inQuiet) return { inQuietHours: false, localTime };
  const [eh, em] = w.end.split(':').map(Number) as [number, number];
  let end = zoned.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (end <= zoned) end = end.plus({ days: 1 }).set({ hour: eh, minute: em });
  return { inQuietHours: true, endsAt: end.toUTC().toJSDate(), localTime };
}

/** Next digest delivery instant (DAILY: next deliveryTime; WEEKLY: next Monday). */
export function nextDigestTime(
  now: Date,
  timezone: string,
  deliveryTime: string,
  frequency: DigestFrequency,
): Date {
  const local = DateTime.fromJSDate(now, { zone: timezone });
  const [h, m] = deliveryTime.split(':').map(Number) as [number, number];
  if (frequency === 'HOURLY') return local.startOf('hour').plus({ hours: 1 }).toUTC().toJSDate();
  let next = local.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (frequency === 'DAILY') {
    if (next <= local) next = next.plus({ days: 1 }).set({ hour: h, minute: m });
  } else {
    const daysUntilMonday = (8 - next.weekday) % 7;
    next = next.plus({ days: daysUntilMonday }).set({ hour: h, minute: m });
    if (next <= local) next = next.plus({ weeks: 1 }).set({ hour: h, minute: m });
  }
  return next.toUTC().toJSDate();
}
