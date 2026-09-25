import { normalizeSearchText, searchWords, hasBengali } from './normalize';

/**
 * Bengali → Latin transliteration the way people actually type Bengali in
 * Latin letters ("Banglish"), not a scholarly scheme (ISO 15919 would give
 * "ḍāktār"). Nobody searches with diacritics; they type "daktar", "basha",
 * "shobji", "gari".
 *
 * Two outputs:
 *   - `transliterate(text)`: one primary spelling per word — the value of a
 *     document's `name_translit`.
 *   - `transliterationVariants(word)`: the other common spellings of the same
 *     word (স as s/sh, ভ as bh/v, the inherent vowel as o/a, ফ as ph/f, …), for
 *     `name_variants`, so "basa", "basha", "sobji", "shobji", "sabji" all hit.
 *
 * English equivalents ("doctor" for ডাক্তার, "electrician" for
 * ইলেকট্রিশিয়ান) are not phonetics; they come from the synonym dictionary
 * (docs/specs/search-synonyms.md) via `search-terms.ts`.
 *
 * How a word is read:
 *   1. Split into syllable units: a consonant cluster (consonants joined by
 *      hasanta ্, including reph র্ and the ya/ra/ba-phala) with its vowel sign,
 *      or an independent vowel, each with trailing ং ঃ ঁ.
 *   2. A cluster without a vowel sign carries the inherent vowel (o/a) —
 *      except where Bengali drops it ("schwa deletion"):
 *        - at the end of a word (ডাক্তার → daktar), unless the cluster is a
 *          conjunct (শান্ত → shanto) or the letter is হ (দেহ → deho);
 *        - in the middle, between a vowel and a consonant carrying a vowel
 *          sign (মিরপুর → mirpur, সবজি → sobji, ইলেকট্রিশিয়ান → ilektrishiyan).
 *      This is the common rule, not a complete one; the variants, Meilisearch
 *      typo tolerance and the synonym dictionary cover what it misses.
 */

type Options = readonly [primary: string, ...alternatives: string[]];

const VIRAMA = '\u09CD';
const NUKTA = '\u09BC';

const CONSONANTS: Readonly<Record<string, Options>> = {
  ক: ['k'],
  খ: ['kh'],
  গ: ['g'],
  ঘ: ['gh'],
  ঙ: ['ng'],
  চ: ['ch', 'c'],
  ছ: ['ch', 'chh'],
  জ: ['j', 'z'],
  ঝ: ['jh', 'j'],
  ঞ: ['n'],
  ট: ['t'],
  ঠ: ['th', 't'],
  ড: ['d'],
  ঢ: ['dh', 'd'],
  ণ: ['n'],
  ত: ['t'],
  থ: ['th'],
  দ: ['d'],
  ধ: ['dh', 'd'],
  ন: ['n'],
  প: ['p'],
  ফ: ['ph', 'f'],
  ব: ['b'],
  ভ: ['bh', 'v'],
  ম: ['m'],
  য: ['j', 'z'],
  র: ['r'],
  ল: ['l'],
  শ: ['sh', 's'],
  ষ: ['sh', 's'],
  স: ['s', 'sh'],
  হ: ['h'],
  // After NFC these arrive as base + nukta (see normalize.ts); keyed that way.
  [`ড${NUKTA}`]: ['r'],
  [`ঢ${NUKTA}`]: ['rh', 'r'],
  [`য${NUKTA}`]: ['y'],
  ৎ: ['t'],
};

const INDEPENDENT_VOWELS: Readonly<Record<string, Options>> = {
  অ: ['o', 'a'],
  আ: ['a'],
  ই: ['i'],
  ঈ: ['i', 'ee'],
  উ: ['u'],
  ঊ: ['u', 'oo'],
  ঋ: ['ri'],
  এ: ['e'],
  ঐ: ['oi'],
  ও: ['o'],
  ঔ: ['ou'],
};

const VOWEL_SIGNS: Readonly<Record<string, Options>> = {
  'া': ['a'],
  'ি': ['i'],
  'ী': ['i', 'ee'],
  'ু': ['u'],
  'ূ': ['u', 'oo'],
  'ৃ': ['ri'],
  'ে': ['e'],
  'ৈ': ['oi'],
  'ো': ['o'],
  'ৌ': ['ou'],
};

/** ং ঃ ঁ after a syllable. Candrabindu only nasalises, so it is dropped. */
const MODIFIERS: Readonly<Record<string, Options>> = {
  'ং': ['ng', 'n'],
  'ঃ': [''],
  'ঁ': [''],
};

/** Clusters read as a whole rather than letter by letter. */
const SPECIAL_CLUSTERS: Readonly<Record<string, Options>> = {
  [`ক${VIRAMA}ষ`]: ['kh', 'kkh', 'ksh'],
  [`জ${VIRAMA}ঞ`]: ['gy', 'gg'],
};

const INHERENT: Options = ['o', 'a'];
/**
 * A word-final conjunct keeps its vowel in native words (শান্ত → shanto) but
 * not in English loans (রেস্টুরেন্ট → restaurant, লিস্ট → list): both kept.
 */
const INHERENT_FINAL_CONJUNCT: Options = ['o', 'a', ''];

// settings-exempt: bounds work per word at index time (combinatorics), not a business rule
const MAX_VARIANTS_PER_WORD = 24;

interface Unit {
  /** Consonant letters of the cluster (with nukta), or empty for a vowel unit. */
  consonants: string[];
  /** Explicit vowel: a sign after a cluster, or the independent vowel itself. */
  vowel: string | null;
  /** Ends in a bare hasanta (ক্ at the end of a word): no vowel at all. */
  bareVirama: boolean;
  modifiers: string[];
}

function isConsonant(ch: string): boolean {
  return ch in CONSONANTS || `${ch}${NUKTA}` in CONSONANTS;
}

function parseUnits(word: string): Unit[] {
  const chars = [...word];
  const units: Unit[] = [];
  let i = 0;
  const readConsonant = (): string => {
    let letter = chars[i]!;
    i++;
    if (chars[i] === NUKTA) {
      letter += NUKTA;
      i++;
    }
    return letter;
  };

  while (i < chars.length) {
    const ch = chars[i]!;
    if (ch in INDEPENDENT_VOWELS) {
      units.push({ consonants: [], vowel: ch, bareVirama: false, modifiers: [] });
      i++;
    } else if (isConsonant(ch)) {
      const unit: Unit = {
        consonants: [readConsonant()],
        vowel: null,
        bareVirama: false,
        modifiers: [],
      };
      while (chars[i] === VIRAMA) {
        if (i + 1 < chars.length && isConsonant(chars[i + 1]!)) {
          i++;
          unit.consonants.push(readConsonant());
        } else {
          unit.bareVirama = true;
          i++;
          break;
        }
      }
      if (!unit.bareVirama && chars[i] !== undefined && chars[i]! in VOWEL_SIGNS) {
        unit.vowel = chars[i]!;
        i++;
      }
      units.push(unit);
    } else if (ch in MODIFIERS && units.length > 0) {
      units.at(-1)!.modifiers.push(ch);
      i++;
    } else {
      // A stray sign or an unknown code point: skip it rather than fail.
      i++;
    }
    while (i < chars.length && chars[i]! in MODIFIERS && units.length > 0) {
      units.at(-1)!.modifiers.push(chars[i]!);
      i++;
    }
  }
  return units;
}

/** A unit "has a vowel" once its inherent-vowel decision is made. */
function inherentVowelKept(units: Unit[], index: number, kept: boolean[]): boolean {
  const unit = units[index]!;
  if (unit.consonants.length === 0 || unit.vowel !== null || unit.bareVirama) return false;
  const isLast = index === units.length - 1;
  if (units.length === 1) return true;
  if (isLast) {
    const conjunct = unit.consonants.length > 1 && unit.consonants[0] !== 'র';
    return conjunct || unit.consonants.at(-1) === 'হ';
  }
  if (index === 0) return true;
  const previous = units[index - 1]!;
  const previousHasVowel =
    previous.vowel !== null || (previous.consonants.length > 0 && kept[index - 1] === true);
  const next = units[index + 1]!;
  const nextHasSign = next.consonants.length > 0 && next.vowel !== null;
  const conjunct = unit.consonants.length > 1;
  return !(previousHasVowel && nextHasSign && !conjunct);
}

/** One slot of the spelling: fixed text, or a choice among options. */
type Slot = Options;

function clusterSlots(consonants: string[]): Slot[] {
  const slots: Slot[] = [];
  let k = 0;
  while (k < consonants.length) {
    const pair =
      consonants[k + 1] === undefined ? undefined : `${consonants[k]}${VIRAMA}${consonants[k + 1]}`;
    if (pair !== undefined && pair in SPECIAL_CLUSTERS) {
      slots.push(SPECIAL_CLUSTERS[pair]!);
      k += 2;
      continue;
    }
    const letter = consonants[k]!;
    if (k > 0 && letter === 'য') {
      // ya-phala (ব্যাংক → byank / bank)
      slots.push(['y', '']);
    } else if (k > 0 && letter === 'ব' && consonants[k - 1] !== 'ম') {
      // ba-phala is mostly silent (বিশ্ব → bishsho); after ম it's a b (প্লাম্বার).
      slots.push(['', 'b', 'w']);
    } else {
      slots.push(CONSONANTS[letter] ?? ['']);
    }
    k++;
  }
  return slots;
}

function wordSlots(word: string): Slot[] {
  const units = parseUnits(word);
  const kept: boolean[] = [];
  const slots: Slot[] = [];
  units.forEach((unit, index) => {
    kept[index] = inherentVowelKept(units, index, kept);
    if (unit.consonants.length === 0) {
      slots.push(INDEPENDENT_VOWELS[unit.vowel!]!);
    } else {
      slots.push(...clusterSlots(unit.consonants));
      if (unit.vowel !== null) slots.push(VOWEL_SIGNS[unit.vowel]!);
      else if (kept[index]) {
        const finalConjunct = index === units.length - 1 && unit.consonants.length > 1;
        slots.push(finalConjunct ? INHERENT_FINAL_CONJUNCT : INHERENT);
      }
    }
    for (const modifier of unit.modifiers) slots.push(MODIFIERS[modifier]!);
  });
  return slots;
}

const primaryOf = (slots: Slot[]): string => slots.map((s) => s[0]).join('');

/** Primary Banglish spelling of one Bengali word; Latin words pass through normalised. */
export function transliterateWord(word: string): string {
  return hasBengali(word) ? primaryOf(wordSlots(word)) : normalizeSearchText(word);
}

/** Primary Banglish spelling of a whole text, word by word. */
export function transliterate(text: string): string {
  return searchWords(text).map(transliterateWord).join(' ');
}

/**
 * Other common spellings of one word, primary first. Variants are generated
 * by how far they stray from the primary (one changed letter, then two), so
 * the cap keeps the most likely ones on long words with many choices.
 */
export function transliterationVariants(word: string): string[] {
  if (!hasBengali(word)) return [normalizeSearchText(word)];
  const slots = wordSlots(word);
  const choice = slots.map(() => 0);
  const seen = new Set<string>([primaryOf(slots)]);
  const spell = (picks: number[]) => slots.map((s, i) => s[picks[i]!]!).join('');
  const add = (picks: number[]) => {
    if (seen.size < MAX_VARIANTS_PER_WORD) seen.add(spell(picks));
  };

  const ambiguous = slots.flatMap((s, i) => (s.length > 1 ? [i] : []));
  for (const a of ambiguous) {
    for (let x = 1; x < slots[a]!.length; x++) add(choice.map((c, i) => (i === a ? x : c)));
  }
  for (let p = 0; p < ambiguous.length; p++) {
    for (let q = p + 1; q < ambiguous.length; q++) {
      const a = ambiguous[p]!;
      const b = ambiguous[q]!;
      for (let x = 1; x < slots[a]!.length; x++) {
        for (let y = 1; y < slots[b]!.length; y++) {
          add(choice.map((c, i) => (i === a ? x : i === b ? y : c)));
        }
      }
    }
  }
  return [...seen].filter((v) => v !== '');
}
