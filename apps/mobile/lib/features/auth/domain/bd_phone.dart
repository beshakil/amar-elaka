// Mirrors apps/api/src/auth/phone/phone-normalizer.ts's BD_MOBILE_PATTERN
// exactly, so client-side validation never disagrees with the server:
// 01XXXXXXXXX / 8801XXXXXXXXX / +8801XXXXXXXXX, operator prefixes 013–019.
final _bdMobilePattern = RegExp(r'^(?:\+?880|0)(1[3-9]\d{8})$');

/// Strips everything but digits and a leading `+` — the input may be the
/// user-facing formatted display value (`01712-345678`), not raw digits.
String _stripFormatting(String input) {
  final trimmed = input.trim();
  final hasPlus = trimmed.startsWith('+');
  final digits = trimmed.replaceAll(RegExp(r'\D'), '');
  return hasPlus ? '+$digits' : digits;
}

bool isValidBdPhone(String input) =>
    _bdMobilePattern.hasMatch(_stripFormatting(input));

/// Normalizes to E.164 (`+8801XXXXXXXXX`) for the request body. Returns null
/// for an invalid number (callers should have already checked [isValidBdPhone]).
String? normalizeBdPhone(String input) {
  final match = _bdMobilePattern.firstMatch(_stripFormatting(input));
  if (match == null) return null;
  return '+880${match.group(1)}';
}
