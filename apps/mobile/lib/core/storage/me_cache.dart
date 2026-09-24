import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';

part 'me_cache.g.dart';

const _prefsKey = 'auth.cached_me';

/// Last-known `MeResult`, `SharedPreferences`-backed (not secret, unlike
/// tokens — doesn't belong in `flutter_secure_storage`). Lets
/// `AuthController` keep a returning user authenticated while offline
/// instead of forcing a logout just because `/auth/me` couldn't be reached.
class MeCache {
  MeCache(this._prefs);

  final SharedPreferences _prefs;

  MeResult? read() {
    final raw = _prefs.getString(_prefsKey);
    if (raw == null) return null;
    try {
      return MeResult.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } on FormatException {
      return null;
    } on TypeError {
      return null;
    }
  }

  Future<void> save(MeResult me) =>
      _prefs.setString(_prefsKey, jsonEncode(me.toJson()));

  Future<void> clear() => _prefs.remove(_prefsKey);
}

@riverpod
Future<MeCache> meCache(Ref ref) async {
  return MeCache(await SharedPreferences.getInstance());
}
