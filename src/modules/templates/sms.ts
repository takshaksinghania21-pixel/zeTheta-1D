/**
 * SMS length rules (3GPP TS 23.038):
 *  - GSM-7: 160 chars single, 153 per part when concatenated; extension-table
 *    characters ({}[]~\^|€ and form feed) cost two septets.
 *  - Otherwise UCS-2: 70 UTF-16 code units single, 67 per part.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';
const BASIC = new Set(Array.from(GSM_BASIC));
const EXTENDED = new Set(Array.from(GSM_EXTENDED));

export interface SmsInfo {
  encoding: 'GSM-7' | 'UCS-2';
  /** Length in encoding units (septets for GSM-7, UTF-16 code units for UCS-2). */
  units: number;
  segments: number;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) if (!BASIC.has(ch) && !EXTENDED.has(ch)) return false;
  return true;
}

function gsmUnits(text: string): number {
  let n = 0;
  for (const ch of text) n += EXTENDED.has(ch) ? 2 : 1;
  return n;
}

export function smsInfo(text: string): SmsInfo {
  if (isGsm7(text)) {
    const units = gsmUnits(text);
    return {
      encoding: 'GSM-7',
      units,
      segments: units === 0 ? 1 : units <= 160 ? 1 : Math.ceil(units / 153),
    };
  }
  const units = text.length; // UTF-16 code units
  return {
    encoding: 'UCS-2',
    units,
    segments: units === 0 ? 1 : units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

export function maxUnits(encoding: 'GSM-7' | 'UCS-2', maxSegments: number): number {
  if (encoding === 'GSM-7') return maxSegments === 1 ? 160 : 153 * maxSegments;
  return maxSegments === 1 ? 70 : 67 * maxSegments;
}

/** Truncates to the segment budget, never splitting a surrogate pair. */
export function truncateSms(
  text: string,
  maxSegments: number,
): { text: string; truncated: boolean } {
  const info = smsInfo(text);
  const limit = maxUnits(info.encoding, maxSegments);
  if (info.units <= limit) return { text, truncated: false };
  const ellipsis = '...';
  const budget = limit - ellipsis.length;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const cost = info.encoding === 'GSM-7' ? (EXTENDED.has(ch) ? 2 : 1) : ch.length;
    if (used + cost > budget) break;
    out += ch;
    used += cost;
  }
  return { text: out.trimEnd() + ellipsis, truncated: true };
}
