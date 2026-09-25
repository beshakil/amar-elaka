import type { Locale } from './schema';

/**
 * Bengali numerals and South Asian digit grouping.
 *
 * Display uses Bengali digits (০–৯) in the bn locale. Input accepts either
 * script, because many keyboards and SMS-trained habits produce Latin
 * digits; everything is normalised to Latin before parsing, and the API only
 * ever sees Latin digits. Grouping is lakh/crore style: the last three digits,
 * then pairs (12,34,567), done on the digit string so money never passes
 * through a float.
 */

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';
const LATIN_ZERO = '0'.charCodeAt(0);
const BENGALI_ZERO = BENGALI_DIGITS.charCodeAt(0);

/** Bengali (and Latin) digits -> Latin digits; everything else unchanged. */
export function toLatinDigits(value: string): string {
  return value.replace(/[০-৯]/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) - BENGALI_ZERO + LATIN_ZERO),
  );
}

export function toBengaliDigits(value: string): string {
  return value.replace(/[0-9]/g, (d) => BENGALI_DIGITS[d.charCodeAt(0) - LATIN_ZERO]!);
}

export function localizeDigits(value: string, locale: Locale): string {
  return locale === 'bn' ? toBengaliDigits(value) : value;
}

/** "1234567" -> "12,34,567" (Latin digits, no sign or decimals). */
export function groupSouthAsian(digits: string): string {
  const tail = digits.slice(-3);
  const head = digits.slice(0, -3);
  if (head === '') return tail;
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

/** Stored money, "1234567.00" -> "১২,৩৪,৫৬৭" (bn) / "12,34,567" (en); non-zero paisa kept. */
export function formatMoney(money: string, locale: Locale): string {
  const [whole = '0', fraction = ''] = money.split('.');
  const grouped = groupSouthAsian(whole.replace(/^0+(?=\d)/, ''));
  const text = /^0*$/.test(fraction) ? grouped : `${grouped}.${fraction}`;
  return localizeDigits(text, locale);
}

/** A plain number for display: digits localised, no grouping (years, counts). */
export function formatNumber(value: number, locale: Locale): string {
  return localizeDigits(String(value), locale);
}

/** Money as typed ("১৫,০০০", "15000.5", "৳ 1,50,000") -> "15000.50"; undefined if not an amount. */
export function parseMoneyInput(input: string): string | undefined {
  const cleaned = toLatinDigits(input).replace(/[,\s৳]/g, '');
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return undefined;
  const [, whole, fraction = ''] = match;
  return `${whole!.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}

/** A number as typed, in either script; NaN if it isn't one. Grouping commas are ignored. */
export function parseNumberInput(input: string): number {
  const cleaned = toLatinDigits(input).replace(/[,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
}

/**
 * A Bangladeshi number as typed ("০১৭১১-০০০০০০", "+880 1711 000000") ->
 * E.164 ("+8801711000000"); other input comes back digit-normalised only,
 * so the validator reports it as invalid.
 */
export function normalizePhoneInput(input: string): string {
  const cleaned = toLatinDigits(input).replace(/[\s\-()]/g, '');
  if (/^0\d{7,10}$/.test(cleaned)) return `+88${cleaned}`;
  if (/^880\d{7,10}$/.test(cleaned)) return `+${cleaned}`;
  return cleaned;
}
