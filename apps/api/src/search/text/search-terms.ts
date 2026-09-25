import { latinEquivalents, type SynonymLine } from '../synonyms/synonym-dictionary';
import { hasBengali, normalizeSearchText, searchWords, ZERO_WIDTH } from './normalize';
import { transliterate, transliterateWord, transliterationVariants } from './transliterate';

/**
 * Index-side and query-side use of normalisation, transliteration and the
 * synonym dictionary. Pure: the dictionary is passed in.
 */

// settings-exempt: bounds the searchable noise one document can add to the index, not a business rule
const MAX_VARIANTS_PER_DOCUMENT = 80;
// settings-exempt: see above — only a query this short is doubled with its transliteration
const MAX_EXPANDED_QUERY_WORDS = 6;

/** Display-safe cleanup for stored text: NFC and no zero-width characters, case and digits kept. */
export function cleanDisplayText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const cleaned = text.normalize('NFC').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

export interface NameFields {
  name_bn: string | null;
  name_en: string | null;
  name_translit: string;
  name_variants: string[];
}

export class SearchTerms {
  private readonly equivalents: Map<string, string[]>;

  constructor(lines: readonly SynonymLine[]) {
    this.equivalents = latinEquivalents(lines);
  }

  /**
   * Stores and places have both name columns; a post has one free-text title,
   * which goes to `name_bn` when it contains Bengali script (mixed titles
   * included) and to `name_en` otherwise.
   */
  nameFields(names: { bn?: string | null; en?: string | null; title?: string | null }): NameFields {
    let bn = cleanDisplayText(names.bn);
    let en = cleanDisplayText(names.en);
    const title = cleanDisplayText(names.title);
    if (title !== null) {
      if (hasBengali(title)) bn ??= title;
      else en ??= title;
    }
    const source = bn ?? en ?? '';
    const translit = transliterate(source);
    return {
      name_bn: bn,
      name_en: en,
      name_translit: translit,
      name_variants: this.variants(bn ?? '', new Set(searchWords(`${translit} ${en ?? ''}`))),
    };
  }

  /** Banglish of the Bengali words of a text only (Latin words are already searchable as they are). */
  bengaliTranslit(text: string | null): string | null {
    if (text === null) return null;
    const words = searchWords(text).filter((w) => hasBengali(w));
    return words.length === 0 ? null : words.map(transliterateWord).join(' ');
  }

  /** Transliteration of any Bengali text (category and area names), or null. */
  translit(text: string | null): string | null {
    if (text === null) return null;
    const result = transliterate(text);
    return result === '' ? null : result;
  }

  /**
   * Other spellings of each Bengali word, plus the English words the
   * dictionary gives for any Bengali word or phrase in the text.
   */
  variants(bengaliText: string, exclude: ReadonlySet<string> = new Set()): string[] {
    const words = searchWords(bengaliText).filter((w) => hasBengali(w));
    const found = new Set<string>();
    const normalized = ` ${words.join(' ')} `;
    for (const [term, latin] of this.equivalents) {
      if (normalized.includes(` ${term} `)) latin.forEach((l) => found.add(l));
    }
    for (const word of words) transliterationVariants(word).forEach((v) => found.add(v));
    return [...found].filter((v) => !exclude.has(v)).slice(0, MAX_VARIANTS_PER_DOCUMENT);
  }

  /**
   * The query actually sent to Meilisearch. A Bengali word also matches Latin
   * names only through its transliteration, so a short query gets its
   * Banglish spelling first and the original after: "ডাক্তার রহিম" →
   * "daktar rohim ডাক্তার রহিম". Meilisearch drops words from the end when
   * nothing matches them all (matchingStrategy "last"), so a Latin-only
   * listing ("Dr. Rahim") still matches on the transliterated words.
   */
  expandQuery(q: string): string {
    const normalized = normalizeSearchText(q);
    const words = searchWords(normalized);
    if (!words.some((w) => hasBengali(w)) || words.length > MAX_EXPANDED_QUERY_WORDS) {
      return normalized;
    }
    const translit = words.map(transliterateWord).join(' ');
    return `${translit} ${words.filter((w) => hasBengali(w)).join(' ')}`;
  }
}
