/** rule 6: no hardcoded user-facing strings in application code — this is the one place the OTP SMS body is defined. */
const TEMPLATES: Record<'bn' | 'en', (code: string) => string> = {
  bn: (code) => `আপনার আমার এলাকা যাচাইকরণ কোড: ${code}। এটি কারও সাথে শেয়ার করবেন না।`,
  en: (code) => `Your Amar Elaka verification code is ${code}. Do not share it with anyone.`,
};

/** No account/locale is known yet at OTP-request time, so this defaults to Bengali (the platform default locale). */
export function otpMessage(code: string, locale: 'bn' | 'en' = 'bn'): string {
  return TEMPLATES[locale](code);
}
