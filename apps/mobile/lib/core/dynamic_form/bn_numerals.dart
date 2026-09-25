/// Bengali numerals and South Asian digit grouping — the Dart twin of
/// packages/dynamic-form/src/numerals.ts.
///
/// Display uses Bengali digits (০–৯) in the bn locale; input accepts either
/// script and is normalised to Latin before parsing, so the API only ever sees
/// Latin digits. Money is grouped lakh/crore style (১২,৩৪,৫৬৭) on the digit
/// string, never through a double.
library;

const _bengaliDigits = '০১২৩৪৫৬৭৮৯';
final int _latinZero = '0'.codeUnitAt(0);
final int _bengaliZero = _bengaliDigits.codeUnitAt(0);

/// Bengali digits -> Latin; everything else unchanged.
String toLatinDigits(String value) => value.replaceAllMapped(
  RegExp('[০-৯]'),
  (m) => String.fromCharCode(m[0]!.codeUnitAt(0) - _bengaliZero + _latinZero),
);

String toBengaliDigits(String value) => value.replaceAllMapped(
  RegExp('[0-9]'),
  (m) => _bengaliDigits[m[0]!.codeUnitAt(0) - _latinZero],
);

String localizeDigits(String value, String locale) =>
    locale == 'bn' ? toBengaliDigits(value) : value;

/// "1234567" -> "12,34,567" (Latin digits, no sign or decimals).
String groupSouthAsian(String digits) {
  if (digits.length <= 3) return digits;
  final head = digits.substring(0, digits.length - 3);
  final tail = digits.substring(digits.length - 3);
  final groupedHead = head.replaceAllMapped(
    RegExp(r'\B(?=(\d{2})+(?!\d))'),
    (_) => ',',
  );
  return '$groupedHead,$tail';
}

/// Stored money "1234567.00" -> "১২,৩৪,৫৬৭" (bn); non-zero paisa kept.
String formatMoney(String money, String locale) {
  final parts = money.split('.');
  final whole = parts[0].replaceFirst(RegExp(r'^0+(?=\d)'), '');
  final fraction = parts.length > 1 ? parts[1] : '';
  final grouped = groupSouthAsian(whole.isEmpty ? '0' : whole);
  final text = RegExp(r'^0*$').hasMatch(fraction)
      ? grouped
      : '$grouped.$fraction';
  return localizeDigits(text, locale);
}

/// A plain number for display: digits localised, no grouping (years, counts).
String formatNumber(num value, String locale) =>
    localizeDigits(_plain(value), locale);

String _plain(num value) =>
    value is int || value == value.roundToDouble() && value.abs() < 1e15
    ? value.toInt().toString()
    : value.toString();

/// Money as typed ("১৫,০০০", "৳ 1,50,000.5") -> "15000.00"; null if not an amount.
String? parseMoneyInput(String input) {
  final cleaned = toLatinDigits(input).replaceAll(RegExp(r'[,\s৳]'), '');
  final match = RegExp(r'^(\d{1,10})(?:\.(\d{1,2}))?$').firstMatch(cleaned);
  if (match == null) return null;
  final whole = match[1]!.replaceFirst(RegExp(r'^0+(?=\d)'), '');
  final fraction = (match[2] ?? '').padRight(2, '0');
  return '$whole.$fraction';
}

/// A number as typed in either script; null if it isn't one.
num? parseNumberInput(String input) {
  final cleaned = toLatinDigits(input).replaceAll(RegExp(r'[,\s]'), '');
  if (!RegExp(r'^-?\d+(\.\d+)?$').hasMatch(cleaned)) return null;
  return cleaned.contains('.') ? double.parse(cleaned) : int.parse(cleaned);
}

/// A Bangladeshi number as typed -> E.164 ("+8801711000000"); other input
/// comes back digit-normalised only, so the validator reports it.
String normalizePhoneInput(String input) {
  final cleaned = toLatinDigits(input).replaceAll(RegExp(r'[\s\-()]'), '');
  if (RegExp(r'^0\d{7,10}$').hasMatch(cleaned)) return '+88$cleaned';
  if (RegExp(r'^880\d{7,10}$').hasMatch(cleaned)) return '+$cleaned';
  return cleaned;
}
