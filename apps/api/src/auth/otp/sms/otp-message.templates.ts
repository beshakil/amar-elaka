/** rule 6: no hardcoded user-facing strings in application code — this is the one place the OTP SMS bodies are defined. */
const TEMPLATES: Record<'login' | 'place_claim', Record<'bn' | 'en', (code: string) => string>> = {
  login: {
    bn: (code) => `আপনার আমার এলাকা যাচাইকরণ কোড: ${code}। এটি কারও সাথে শেয়ার করবেন না।`,
    en: (code) => `Your Amar Elaka verification code is ${code}. Do not share it with anyone.`,
  },
  // The owner must know what the code would do: someone is claiming their shop.
  place_claim: {
    bn: (code) =>
      `আমার এলাকা: আপনার দোকানের মালিকানা দাবির কোড ${code}। আপনি দাবি না করে থাকলে কাউকে এই কোড দেবেন না।`,
    en: (code) =>
      `Amar Elaka: code ${code} confirms a claim to own your shop. If you did not make this claim, do not share it.`,
  },
};

/** No account/locale is known yet at OTP-request time, so this defaults to Bengali (the platform default locale). */
export function otpMessage(
  code: string,
  locale: 'bn' | 'en' = 'bn',
  purpose: 'login' | 'place_claim' = 'login',
): string {
  return TEMPLATES[purpose][locale](code);
}
