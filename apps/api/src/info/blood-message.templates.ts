/**
 * rule 6: no hardcoded user-facing strings in application code — this is the
 * one place the prefilled SMS/WhatsApp text between a blood requester and a
 * donor is defined (the contact-message.templates.ts pattern). The group is
 * its ABO/Rh symbol, the same in both languages.
 */
const TO_DONOR: Record<'bn' | 'en', (group: string) => string> = {
  bn: (group) =>
    `আসসালামু আলাইকুম। "আমার এলাকা" অ্যাপের রক্তদাতা তালিকায় আপনাকে পেয়েছি। ${group} রক্ত প্রয়োজন — আপনি কি দিতে পারবেন?`,
  en: (group) =>
    `Hello! I found you on the Amar Elaka blood donor list. We need ${group} blood — could you donate?`,
};

const TO_REQUESTER: Record<'bn' | 'en', (group: string, hospital: string) => string> = {
  bn: (group, hospital) =>
    `আসসালামু আলাইকুম। "আমার এলাকা" অ্যাপে আপনার ${group} রক্তের অনুরোধ (${hospital}) দেখলাম। আমি রক্ত দিতে পারি।`,
  en: (group, hospital) =>
    `Hello! I saw your request for ${group} blood (${hospital}) on Amar Elaka. I can donate.`,
};

/** What a requester sends a donor who shares their number. */
export function donorContactMessage(group: string, locale: 'bn' | 'en' = 'bn'): string {
  return TO_DONOR[locale](group);
}

/** What a donor sends the person who posted an urgent request. */
export function requesterContactMessage(
  group: string,
  hospital: string,
  locale: 'bn' | 'en' = 'bn',
): string {
  return TO_REQUESTER[locale](group, hospital);
}
