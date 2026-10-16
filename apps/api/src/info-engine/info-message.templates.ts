/**
 * rule 6: no hardcoded user-facing strings in application code — this is the
 * one place the prefilled SMS/WhatsApp text to a lost & found reporter is
 * defined (the contact-message.templates.ts pattern).
 */
const TEMPLATES: Record<'bn' | 'en', (found: boolean, title: string) => string> = {
  bn: (found, title) =>
    found
      ? `আসসালামু আলাইকুম। "আমার এলাকা" অ্যাপে দেখলাম আপনি "${title}" পেয়েছেন। মনে হচ্ছে এটা আমার।`
      : `আসসালামু আলাইকুম। "আমার এলাকা" অ্যাপে আপনার হারানো "${title}"-এর খবর দেখলাম। আমার কাছে তথ্য আছে।`,
  en: (found, title) =>
    found
      ? `Hello! I saw on Amar Elaka that you found "${title}". I think it is mine.`
      : `Hello! I saw your lost "${title}" on Amar Elaka. I have some information.`,
};

export function lostFoundMessage(
  found: boolean,
  title: string,
  locale: 'bn' | 'en' = 'bn',
): string {
  return TEMPLATES[locale](found, title);
}
