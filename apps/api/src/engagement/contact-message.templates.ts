/**
 * rule 6: no hardcoded user-facing strings in application code — this is the
 * one place the prefilled SMS/WhatsApp message to a seller is defined. It
 * names the app and the listing, so the seller knows where the buyer came
 * from, and carries the post's share link when there is one.
 */
const TEMPLATES: Record<'bn' | 'en', (title: string, url: string | null) => string> = {
  bn: (title, url) =>
    `আসসালামু আলাইকুম। "আমার এলাকা" অ্যাপে আপনার "${title}" বিজ্ঞাপনটি দেখলাম। এটি কি এখনও পাওয়া যাবে?` +
    (url ? `\n${url}` : ''),
  en: (title, url) =>
    `Hello! I saw your listing "${title}" on Amar Elaka. Is it still available?` +
    (url ? `\n${url}` : ''),
};

/** Bengali unless the buyer's app asked for English (the platform default locale is bn). */
export function contactMessage(
  title: string,
  url: string | null,
  locale: 'bn' | 'en' = 'bn',
): string {
  return TEMPLATES[locale](title, url);
}
