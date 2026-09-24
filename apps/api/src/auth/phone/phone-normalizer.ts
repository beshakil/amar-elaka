/**
 * Accepts 01XXXXXXXXX, 8801XXXXXXXXX or +8801XXXXXXXXX (operator prefixes
 * 013–019, matching the CHECK on users.phone_e164) and returns the E.164
 * form, or undefined if the input isn't a recognisable BD mobile number.
 */
const BD_MOBILE_PATTERN = /^(?:\+?880|0)(1[3-9]\d{8})$/;

export function normalizeBdPhone(input: string): string | undefined {
  const trimmed = input.trim();
  const match = BD_MOBILE_PATTERN.exec(trimmed);
  return match ? `+880${match[1]}` : undefined;
}
