/**
 * One normalisation for everything that goes into or queries the search
 * index, so both sides always compare the same code points:
 *
 *   - NFC. Bengali has several canonically equal spellings: ো typed as ে + া,
 *     ড় / ঢ় / য় as a single code point or as base + nukta (NFC gives the
 *     decomposed nukta form, both sides alike).
 *   - Zero-width joiners and non-joiners are dropped: keyboards insert them to
 *     control conjunct rendering, and they make identical words compare unequal.
 *   - The old khanda-ta spelling (ত + hasanta + ZWNJ at a word end) becomes ৎ.
 *   - Bengali digits become ASCII, so "৩ রুম" and "3 room" index alike.
 *   - Latin is lower-cased and whitespace collapsed.
 */

export const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const KHANDA_TA_OLD = /\u09A4\u09CD\u200C/g;
const BENGALI_DIGIT = /[\u09E6-\u09EF]/g;
const BENGALI_DIGIT_ZERO = 0x09e6;
const WHITESPACE = /\s+/g;

export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFC')
    .replace(KHANDA_TA_OLD, '\u09CE')
    .replace(ZERO_WIDTH, '')
    .replace(BENGALI_DIGIT, (d) => String(d.charCodeAt(0) - BENGALI_DIGIT_ZERO))
    .toLowerCase()
    .replace(WHITESPACE, ' ')
    .trim();
}

/** Bengali block (U+0980–U+09FF). */
const BENGALI_CHAR = /[\u0980-\u09FF]/;
const LATIN_LETTER = /[a-z]/i;

export function hasBengali(text: string): boolean {
  return BENGALI_CHAR.test(text);
}

export function hasLatin(text: string): boolean {
  return LATIN_LETTER.test(text);
}

/**
 * Words of a normalised text: runs of Bengali letters/signs, Latin letters or
 * digits. Punctuation (including the danda ।) separates words.
 */
const WORD = /[\u0980-\u09E5\u09F0-\u09FF]+|[a-z0-9]+/gi;

export function searchWords(text: string): string[] {
  return normalizeSearchText(text).match(WORD) ?? [];
}

/** The Bengali-script words and the Latin/digit words of a text, each in order. */
export function splitByScript(text: string): { bengali: string[]; latin: string[] } {
  const words = searchWords(text);
  return {
    bengali: words.filter((w) => hasBengali(w)),
    latin: words.filter((w) => !hasBengali(w)),
  };
}
