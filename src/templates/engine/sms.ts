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

/**
 * Fits `text` into `limit` units (septets for GSM-7, UTF-16 units for UCS-2;
 * PDF §A4.3: "SMS body must fit 160 chars"). Truncates with an ellipsis and keeps
 * a trailing link intact; never splits a surrogate pair.
 */
export function truncateSms(text: string, limit: number): { text: string; truncated: boolean } {
  const info = smsInfo(text);
  if (info.units <= limit) return { text, truncated: false };
  const cost = (s: string): number => smsInfo(s).units;
  const link = /\s(https:\/\/\S+)$/.exec(text)?.[1];
  const tail = link && cost(`... ${link}`) < limit ? `... ${link}` : '...';
  const head = link && tail !== '...' ? text.slice(0, text.length - link.length) : text;
  const budget = limit - cost(tail);
  let used = 0;
  let out = '';
  for (const ch of head) {
    const c = info.encoding === 'GSM-7' ? (EXTENDED.has(ch) ? 2 : 1) : ch.length;
    if (used + c > budget) break;
    out += ch;
    used += c;
  }
  return { text: out.trimEnd() + tail, truncated: true };
}
