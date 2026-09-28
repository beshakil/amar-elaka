import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../post/application/current_tenant.dart';

/// The viewer's own recent searches, on this phone only (never sent
/// anywhere): newest first, no duplicates, per tenant.
class RecentSearchesStore {
  RecentSearchesStore(this._tenantId);

  /// How many are kept: a presentation choice (one screenful), not a
  /// business rule the server knows about.
  static const keep = 8;

  final String _tenantId;

  String get _key => 'recent_searches.$_tenantId';

  Future<List<String>> read() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getStringList(_key) ?? const [];
  }

  Future<List<String>> add(String query) async {
    final text = query.trim();
    if (text.isEmpty) return read();
    final current = await read();
    final next = [
      text,
      for (final q in current)
        if (q.toLowerCase() != text.toLowerCase()) q,
    ].take(keep).toList();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_key, next);
    return next;
  }

  Future<List<String>> remove(String query) async {
    final next = [
      for (final q in await read())
        if (q != query) q,
    ];
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_key, next);
    return next;
  }

  Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_key);
  }
}

final recentSearchesStoreProvider = Provider<RecentSearchesStore>(
  (ref) =>
      RecentSearchesStore(ref.watch(currentTenantConfigProvider)?.id ?? 'none'),
);
