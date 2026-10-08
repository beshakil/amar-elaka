import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

const _prefsKey = 'app.locale';

/// The languages the app offers, Bengali first.
const appLocales = [Locale('bn'), Locale('en')];

/// The app's language: Bengali unless the user picked English in Profile
/// (CLAUDE.md rule 6). Not the phone's system language: most phones here run
/// in English, and following them would show most users an English app.
/// Persisted like the theme; `build()` answers Bengali at once and restores
/// a stored choice right after.
class LocaleController extends Notifier<Locale> {
  @override
  Locale build() {
    unawaited(_restore());
    return appLocales.first;
  }

  Future<void> _restore() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_prefsKey);
    final restored = appLocales.firstWhere(
      (l) => l.languageCode == stored,
      orElse: () => appLocales.first,
    );
    if (ref.mounted && restored != state) state = restored;
  }

  Future<void> setLocale(Locale locale) async {
    state = locale;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefsKey, locale.languageCode);
  }
}

final localeControllerProvider = NotifierProvider<LocaleController, Locale>(
  LocaleController.new,
);
