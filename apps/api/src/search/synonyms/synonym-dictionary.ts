import { hasBengali, normalizeSearchText } from '../text/normalize';

/**
 * The synonym dictionary (docs/specs/search-synonyms.md): parsing, validation,
 * and the two shapes the rest of search needs, all pure.
 */

export interface SynonymLine {
  /** Interchangeable terms. */
  terms: string[];
  /** One-way targets: searching any of `terms` also finds these. */
  expandsTo: string[];
}

export class SynonymDictionaryError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid search synonym dictionary:\n  - ${problems.join('\n  - ')}`);
    this.name = 'SynonymDictionaryError';
  }
}

const START = '<!-- dictionary:start -->';
const END = '<!-- dictionary:end -->';
const UPPERCASE_LATIN = /[A-Z]/;
const BULLET = '- ';
// settings-exempt: a group of one term is not a synonym (structural)
const MIN_GROUP_TERMS = 2;

const splitTerms = (text: string): string[] =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

/** Parses and validates the markdown; throws with every problem at once. */
export function parseSynonymDictionary(markdown: string): SynonymLine[] {
  const start = markdown.indexOf(START);
  const end = markdown.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new SynonymDictionaryError([`markers ${START} … ${END} not found`]);
  }

  const problems: string[] = [];
  const lines: SynonymLine[] = [];
  const firstSeen = new Map<string, number>();

  for (const raw of markdown.slice(start + START.length, end).split('\n')) {
    const text = raw.trim();
    if (!text.startsWith(BULLET)) continue;
    const where = `line "${text}"`;
    const [left = '', right, ...extra] = text.slice(BULLET.length).split('->');
    if (extra.length > 0) problems.push(`${where}: more than one "->"`);

    const rawTerms = splitTerms(left);
    const rawTargets = right === undefined ? [] : splitTerms(right);
    for (const term of [...rawTerms, ...rawTargets]) {
      if (!hasBengali(term) && UPPERCASE_LATIN.test(term)) {
        problems.push(`${where}: "${term}" must be lower-case`);
      }
    }

    const terms = [...new Set(rawTerms.map(normalizeSearchText))];
    const expandsTo = [...new Set(rawTargets.map(normalizeSearchText))];
    if (right === undefined && terms.length < MIN_GROUP_TERMS) {
      problems.push(`${where}: a group needs at least two terms`);
    }
    if (right !== undefined && (terms.length === 0 || expandsTo.length === 0)) {
      problems.push(`${where}: a one-way line needs terms on both sides of "->"`);
    }
    if (terms.length !== rawTerms.length) problems.push(`${where}: a term is repeated`);

    for (const term of terms) {
      const seen = firstSeen.get(term);
      if (seen !== undefined) {
        problems.push(`"${term}" starts two lines (${where} and line #${seen + 1})`);
      } else {
        firstSeen.set(term, lines.length);
      }
    }
    lines.push({ terms, expandsTo });
  }

  if (lines.length === 0) problems.push('the dictionary is empty');
  if (problems.length > 0) throw new SynonymDictionaryError(problems);
  return lines;
}

/**
 * Meilisearch's `synonyms` setting: word → words it also matches. Groups are
 * mutual; one-way lines add their targets to each source term only.
 */
export function toMeilisearchSynonyms(
  lines: readonly SynonymLine[],
  extraGroups: readonly (readonly string[])[] = [],
): Record<string, string[]> {
  const synonyms = new Map<string, Set<string>>();
  const link = (from: string, to: Iterable<string>) => {
    const set = synonyms.get(from) ?? new Set<string>();
    for (const t of to) if (t !== from) set.add(t);
    synonyms.set(from, set);
  };
  for (const { terms, expandsTo } of lines) {
    for (const term of terms) link(term, [...terms, ...expandsTo]);
  }
  for (const group of extraGroups) {
    const terms = [...new Set(group.map(normalizeSearchText).filter((t) => t !== ''))];
    if (terms.length < MIN_GROUP_TERMS) continue;
    for (const term of terms) link(term, terms);
  }
  return Object.fromEntries(
    [...synonyms].filter(([, to]) => to.size > 0).map(([from, to]) => [from, [...to].sort()]),
  );
}

/**
 * For each Bengali term, the Latin terms of its line (group members only, not
 * one-way targets): how ইলেকট্রিশিয়ান gets "electrician" into a document.
 */
export function latinEquivalents(lines: readonly SynonymLine[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const { terms } of lines) {
    const latin = terms.filter((t) => !hasBengali(t));
    if (latin.length === 0) continue;
    for (const term of terms.filter((t) => hasBengali(t))) result.set(term, latin);
  }
  return result;
}
