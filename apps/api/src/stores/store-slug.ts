import { transliterate } from '../search/text/transliterate';

/** A store URL slug: lower-case Latin letters and digits in words joined by single hyphens. */
export const STORE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// settings-exempt: URL format bounds — a slug is part of a link, not a business limit
const SLUG_MIN_CHARS = 3;
// settings-exempt: see above
const SLUG_MAX_CHARS = 60;
// settings-exempt: see above; the random tail that makes a taken slug unique
const SUFFIX_CHARS = 4;

/** Paths under /stores that are routes, never a store (0050 checks them too). */
const RESERVED = new Set(['me', 'review-queue']);

/** When the name has no letters to spell (only symbols), the slug starts from this. */
const FALLBACK = 'store';

function slugWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Cut to `max` characters at a word boundary when there is one. */
function cut(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  const lastHyphen = head.lastIndexOf('-');
  return (lastHyphen >= SLUG_MIN_CHARS ? head.slice(0, lastHyphen) : head).replace(/-+$/, '');
}

/**
 * The slug a store's name suggests: the English name when it has one, else
 * the Bengali name in Latin letters (the search transliteration, so
 * "রহিম স্টোর" → "rohim-stor"). Never empty, never reserved.
 */
export function storeSlugFromName(nameBn: string, nameEn: string | null | undefined): string {
  const fromEn = slugWords(nameEn ?? '');
  const base = fromEn.length >= SLUG_MIN_CHARS ? fromEn : slugWords(transliterate(nameBn));
  const slug = cut(
    base.length >= SLUG_MIN_CHARS ? base : `${FALLBACK}-${base}`.replace(/-$/, ''),
    SLUG_MAX_CHARS,
  );
  return RESERVED.has(slug) ? `${FALLBACK}-${slug}` : slug;
}

/** `base` with a random tail, still within the length bound. */
export function withSlugSuffix(base: string, random: () => string): string {
  const tail = random()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, SUFFIX_CHARS);
  return `${cut(base, SLUG_MAX_CHARS - SUFFIX_CHARS - 1)}-${tail}`;
}

export type SlugProblem = 'format' | 'length' | 'reserved';

/** Why an owner's chosen slug can't be used, or null when it can (uniqueness is the database's). */
export function storeSlugProblem(slug: string): SlugProblem | null {
  if (slug.length < SLUG_MIN_CHARS || slug.length > SLUG_MAX_CHARS) return 'length';
  if (!STORE_SLUG_PATTERN.test(slug)) return 'format';
  if (RESERVED.has(slug)) return 'reserved';
  return null;
}
