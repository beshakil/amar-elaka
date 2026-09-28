// URL hygiene, not a business rule: long enough to carry a title's words,
// short enough to keep the URL readable in a search result.
const MAX_SLUG_CHARS = 80;

/**
 * A readable URL slug for a listing title that keeps Bengali intact:
 * letters, vowel signs and the hasanta (Unicode "marks") stay, so conjuncts
 * like ক্ষ and স্ব survive; everything else (spaces, punctuation, the danda)
 * becomes a hyphen. Latin is lower-cased. Zero-width joiners are dropped:
 * invisible, and hostile in a URL. Never empty.
 *
 * The canonical path uses this slug percent-encoded (listingPath); a
 * request with another slug is redirected to it (middleware.ts).
 */
export function listingSlug(title: string): string {
  const slug = title
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‌‍]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const chars = [...slug];
  if (chars.length <= MAX_SLUG_CHARS) return slug || 'listing';
  // Cut at a word boundary, never inside a word (or a conjunct).
  const cut = chars.slice(0, MAX_SLUG_CHARS).join('');
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 0 ? cut.slice(0, lastHyphen) : cut) || 'listing';
}

/** `/listing/<id>/<slug>`, the slug percent-encoded: the canonical listing path. */
export function listingPath(id: string, title: string): string {
  return `/listing/${id}/${encodeURIComponent(listingSlug(title))}`;
}
