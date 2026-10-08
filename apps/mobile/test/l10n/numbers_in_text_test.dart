import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// Numbers inside Bengali sentences are written in Bengali digits (the
/// resend countdown read "33 সেকেন্ড" on a device).
void main() {
  test("the code resend countdown counts in the reader's digits", () {
    expect(
      lookupAppLocalizations(const Locale('bn')).otpResendIn(33),
      startsWith('৩৩ '),
    );
    expect(
      lookupAppLocalizations(const Locale('en')).otpResendIn(33),
      contains('33'),
    );
  });
}
