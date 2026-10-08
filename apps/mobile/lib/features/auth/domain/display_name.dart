import 'package:amar_elaka_api/amar_elaka_api.dart';

/// The name a new account starts with: the phone's last four digits (0013,
/// `upsert_phone_user`), a placeholder until the user gives a real one.
bool hasPlaceholderName(MeResult me) {
  final digits = me.phone.replaceAll(RegExp(r'\D'), '');
  return digits.length >= 4 &&
      me.displayName.trim() == digits.substring(digits.length - 4);
}

/// What the name field starts with: the user's name, or nothing while it is
/// still the placeholder (saved as typed, "0077" would be what buyers see).
String editableDisplayName(MeResult me) =>
    hasPlaceholderName(me) ? '' : me.displayName;
