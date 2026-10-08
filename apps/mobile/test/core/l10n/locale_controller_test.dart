import 'package:amar_elaka_app/core/l10n/locale_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The app's language (CLAUDE.md rule 6): Bengali by default, whatever the
/// phone's language; English only when the user picks it, and remembered.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<void> settle() => Future<void>.delayed(Duration.zero);

  test('Bengali by default, even on a phone set to English', () async {
    SharedPreferences.setMockInitialValues({});
    final container = ProviderContainer();
    addTearDown(container.dispose);
    expect(container.read(localeControllerProvider), const Locale('bn'));
    await settle();
    expect(container.read(localeControllerProvider), const Locale('bn'));
  });

  test(
    'a choice of English is saved and comes back on the next start',
    () async {
      SharedPreferences.setMockInitialValues({});
      final first = ProviderContainer();
      await first
          .read(localeControllerProvider.notifier)
          .setLocale(const Locale('en'));
      expect(first.read(localeControllerProvider), const Locale('en'));
      first.dispose();

      final next = ProviderContainer();
      addTearDown(next.dispose);
      next.read(localeControllerProvider);
      await settle();
      expect(next.read(localeControllerProvider), const Locale('en'));
    },
  );

  test('an unknown stored value falls back to Bengali', () async {
    SharedPreferences.setMockInitialValues({'app.locale': 'fr'});
    final container = ProviderContainer();
    addTearDown(container.dispose);
    container.read(localeControllerProvider);
    await settle();
    expect(container.read(localeControllerProvider), const Locale('bn'));
  });
}
