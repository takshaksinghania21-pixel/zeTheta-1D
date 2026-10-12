/**
 * Deterministic synthetic data shared by the seed and the dataset generator.
 * Phone numbers use the +91 90000 xxxxx test range and emails @example.test;
 * no real personal data is produced.
 */
import type { Category, Channel, Locale, Segment } from '../src/domain/types';

/** mulberry32: small seeded PRNG, so every run produces identical data. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Exactly `n` values distributed by `weights` (largest-remainder rounding), shuffled —
 * so a dataset matches the PDF distribution exactly rather than approximately.
 */
export function quota<T extends string>(
  n: number,
  weights: Record<T, number>,
  rand: () => number,
): T[] {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const counts = entries.map(([k, w]) => {
    const x = (n * w) / total;
    return { k, c: Math.floor(x), rest: x - Math.floor(x) };
  });
  let left = n - counts.reduce((s, x) => s + x.c, 0);
  for (const x of [...counts].sort((a, b) => b.rest - a.rest)) if (left-- > 0) x.c++;
  const out = counts.flatMap((x) => Array<T>(x.c).fill(x.k));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const pick = <T>(xs: readonly T[], rand: () => number): T =>
  xs[Math.floor(rand() * xs.length)]!;

const FIRST = [
  'Asha',
  'Vikram',
  'Meera',
  'Ravi',
  'Priya',
  'Arjun',
  'Kavya',
  'Rohan',
  'Divya',
  'Sanjay',
];
const LAST = [
  'Rao',
  'Shah',
  'Iyer',
  'Kulkarni',
  'Nair',
  'Reddy',
  'Patil',
  'Gupta',
  'Menon',
  'Joshi',
];

/** PDF §B4 language mix: 20% en, 42% hi, 18% mr, 12% ta, 8% te. */
export const LANGUAGE_WEIGHTS: Record<Locale, number> = { en: 20, hi: 42, mr: 18, ta: 12, te: 8 };

export interface SyntheticUser {
  index: number;
  name: string;
  phone: string;
  email: string;
  pushToken: string;
  locale: Locale;
  segment: Segment;
  quietHours: { enabled: boolean; start: string; end: string };
  disabledCategory: Category | null;
  channelsOff: Channel[];
  digest: boolean;
}

export function syntheticUser(index: number, locale: Locale, rand: () => number): SyntheticUser {
  const first = pick(FIRST, rand);
  const last = pick(LAST, rand);
  const segment = pick(
    ['RETAIL', 'RETAIL', 'RETAIL', 'HNI', 'NEW_INVESTOR', 'DORMANT'] as const,
    rand,
  );
  const window = pick(
    [
      { enabled: true, start: '21:00', end: '08:00' },
      { enabled: true, start: '22:00', end: '07:30' },
      { enabled: true, start: '23:00', end: '06:00' },
      { enabled: false, start: '21:00', end: '08:00' },
    ],
    rand,
  );
  return {
    index,
    name: `${first} ${last}`,
    phone: `+9190000${String(index).padStart(5, '0')}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}.${index}@example.test`,
    pushToken: `fcm-test-token-${String(index).padStart(8, '0')}-synthetic`,
    locale,
    segment,
    quietHours: window,
    disabledCategory: rand() < 0.15 ? pick(['MARKET', 'SIP'] as const, rand) : null,
    channelsOff: rand() < 0.2 ? [pick(['email', 'push', 'whatsapp'] as const, rand)] : [],
    digest: rand() < 0.25,
  };
}
