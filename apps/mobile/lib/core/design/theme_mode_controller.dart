import 'dart:async';

import 'package:flutter/material.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';

part 'theme_mode_controller.g.dart';

const _prefsKey = 'app.theme_mode';

/// Light/dark/system, persisted via `shared_preferences`. `build()` returns
/// `ThemeMode.system` immediately (so the UI never blocks on disk I/O) and
/// kicks off an async restore that updates [state] once the stored value
/// loads — a one-frame flash to the system default on cold start is an
/// acceptable trade for not needing an `AsyncNotifier` here.
@riverpod
class ThemeModeController extends _$ThemeModeController {
  @override
  ThemeMode build() {
    unawaited(_restore());
    return ThemeMode.system;
  }

  Future<void> _restore() async {
    final prefs = await SharedPreferences.getInstance();
    final stored = prefs.getString(_prefsKey);
    final restored = ThemeMode.values.firstWhere(
      (mode) => mode.name == stored,
      orElse: () => ThemeMode.system,
    );
    if (restored != state) state = restored;
  }

  Future<void> setThemeMode(ThemeMode mode) async {
    state = mode;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_prefsKey, mode.name);
  }
}
