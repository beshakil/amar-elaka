import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/network/api_exception.dart';
import 'agent_api.dart';
import 'agent_models.dart';

/// What agent mode needs to work with no network all day (ADR 066): the
/// agent's profile and settings, and the place categories to pick from.
class AgentBootstrap {
  const AgentBootstrap({
    required this.me,
    required this.categories,
    required this.fromCache,
  });

  final AgentMe me;
  final List<AgentCategory> categories;

  /// True when this is the phone's kept copy (no network just now).
  final bool fromCache;
}

/// Fetches the bootstrap and keeps a copy per area; offline, the copy.
class AgentBootstrapStore {
  AgentBootstrapStore(this._api, {Future<SharedPreferences> Function()? prefs})
    : _prefs = prefs ?? SharedPreferences.getInstance;

  final AgentApi _api;
  final Future<SharedPreferences> Function() _prefs;

  static String _key(String tenantId) => 'agent_bootstrap:$tenantId';

  /// The fresh one (and kept), or the kept one when offline; null = not an agent here.
  Future<AgentBootstrap?> load(String tenantId) async {
    final prefs = await _prefs();
    try {
      final me = await _api.me();
      final categories = await _api.placeCategories();
      await prefs.setString(
        _key(tenantId),
        jsonEncode({
          'me': me.toJson(),
          'categories': [for (final c in categories) c.toJson()],
        }),
      );
      return AgentBootstrap(me: me, categories: categories, fromCache: false);
    } on ApiException catch (e) {
      // Not (or no longer) an active agent: forget the copy.
      if (e.statusCode == 403) {
        await prefs.remove(_key(tenantId));
        return null;
      }
      return _kept(prefs, tenantId);
    } on AppException {
      return _kept(prefs, tenantId);
    }
  }

  AgentBootstrap? _kept(SharedPreferences prefs, String tenantId) {
    final raw = prefs.getString(_key(tenantId));
    if (raw == null) return null;
    final json = jsonDecode(raw) as Map<String, dynamic>;
    return AgentBootstrap(
      me: AgentMe.fromJson(json['me'] as Map<String, dynamic>),
      categories: [
        for (final c in json['categories'] as List)
          AgentCategory.fromJson(c as Map<String, dynamic>),
      ],
      fromCache: true,
    );
  }
}
