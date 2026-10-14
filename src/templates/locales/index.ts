import type { Locale } from '../../utils/types';

/**
 * Supported notification languages (PDF §A4.1: English, Hindi, Marathi, Tamil, Telugu)
 * and the BCP 47 tags used for Indian number grouping (₹1,00,000) and dates.
 * Translated template text lives in templates/<locale>.yaml; English is the fallback.
 */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  mr: 'mr-IN',
  ta: 'ta-IN',
  te: 'te-IN',
};
