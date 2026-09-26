import { normalizeSearchText } from '../search/text/normalize';

/**
 * The automatic pre-filter run on every submission (ADR 030). Pure text
 * checks live here; the ones that need the database (duplicates, price
 * norms) feed their results in. Tuned for how Bangladeshi scam and spam
 * posts actually dodge filters: Bengali digits (০১৭…), digits split by
 * spaces/dashes/dots, words broken up with hyphens or spaces ("অ-গ্রি-ম"),
 * and mixed case.
 */

export type PrefilterFlag =
  'banned_keyword' | 'contact_info' | 'link_spam' | 'duplicate' | 'price_outlier';

/** Bengali digits → ASCII, zero-width marks gone, lower case, single spaces (Month 1 search normaliser). */
export function normalizeForMatching(text: string): string {
  return normalizeSearchText(text);
}

/** Letters, combining marks and digits only: defeats "অ-গ্রি-ম", "a d v a n c e". */
function squash(text: string): string {
  return normalizeForMatching(text).replace(/[^\p{L}\p{M}\p{N}]+/gu, '');
}

/** The banned keywords/phrases that occur in `text`, as configured. */
export function findBannedKeywords(text: string, keywords: readonly string[]): string[] {
  const normalized = normalizeForMatching(text);
  const squashed = squash(text);
  return keywords.filter((keyword) => {
    const k = normalizeForMatching(keyword);
    const ks = squash(keyword);
    return k !== '' && (normalized.includes(k) || (ks !== '' && squashed.includes(ks)));
  });
}

// A Bangladeshi mobile number, with or without +88 / 88: 01[3-9] + 8 digits.
const BD_MOBILE = /(?:\+?88)?01[3-9]\d{8}/;
// Separators people put between digits to slip past a plain pattern.
const DIGIT_SEPARATORS = /(?<=\d)[\s.\-_()/]+(?=\d)/g;

/** A phone number typed into the text instead of going through the reveal-phone flow. */
export function containsPhoneNumber(text: string): boolean {
  return BD_MOBILE.test(normalizeForMatching(text).replace(DIGIT_SEPARATORS, ''));
}

const LINK =
  /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|xyz|top|site|online|shop|store|link|click|ly|me|io|co|bd|app|page)\b(?:\/[^\s]*)?/giu;

/** Distinct links (URLs, www., or bare domains like bit.ly/x or fb.me/x). */
export function countLinks(text: string): number {
  const found = normalizeForMatching(text).match(LINK) ?? [];
  return new Set(found).size;
}

/** A price this many times above or below the category median. */
export function isPriceOutlier(price: number, median: number, factor: number): boolean {
  if (median <= 0 || price <= 0) return false;
  return price > median * factor || price < median / factor;
}

export interface TextPrefilterInput {
  title: string;
  description: string | null;
  bannedKeywords: readonly string[];
  maxLinks: number;
}

/** The text-only checks, in a stable order. */
export function textFlags(input: TextPrefilterInput): PrefilterFlag[] {
  const text = `${input.title}\n${input.description ?? ''}`;
  const flags: PrefilterFlag[] = [];
  if (findBannedKeywords(text, input.bannedKeywords).length > 0) flags.push('banned_keyword');
  if (containsPhoneNumber(text)) flags.push('contact_info');
  if (countLinks(text) > input.maxLinks) flags.push('link_spam');
  return flags;
}
