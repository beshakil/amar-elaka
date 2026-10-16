/** rule 6: no hardcoded user-facing strings in application code — this is the one place the OTP SMS bodies are defined. */
const TEMPLATES: Record<
  'login' | 'place_claim' | 'appeal' | 'agent_shop_phone',
  Record<'bn' | 'en', (code: string) => string>
> = {
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
  // Proves the phone for an appeal; it can't sign anyone in.
  appeal: {
    bn: (code) =>
      `আমার এলাকা: নিষেধাজ্ঞার আপিলের কোড ${code}। এটি দিয়ে লগইন হয় না, কাউকে দেবেন না।`,
    en: (code) =>
      `Amar Elaka: your ban appeal code is ${code}. It does not sign you in; do not share it.`,
  },
  // The shop owner tells it to the field agent in front of them: it only confirms the number.
  agent_shop_phone: {
    bn: (code) =>
      `আমার এলাকা: আপনার দোকানের নম্বর যাচাইয়ের কোড ${code}। শুধু আপনার দোকানে আসা আমার এলাকার প্রতিনিধিকে বলুন।`,
    en: (code) =>
      `Amar Elaka: code ${code} confirms your shop's number. Tell it only to the Amar Elaka agent at your shop.`,
  },
};

/** No account/locale is known yet at OTP-request time, so this defaults to Bengali (the platform default locale). */
export function otpMessage(
  code: string,
  locale: 'bn' | 'en' = 'bn',
  purpose: 'login' | 'place_claim' | 'appeal' | 'agent_shop_phone' = 'login',
): string {
  return TEMPLATES[purpose][locale](code);
}
