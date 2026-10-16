import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/storage/app_database.dart';
import '../../../core/storage/app_database_provider.dart';
import 'info_api.dart';
import 'info_models.dart';

/// Where the emergency page on screen came from.
enum EmergencySource {
  /// Fresh from the API just now.
  live,

  /// The copy kept in Drift (any age).
  cached,

  /// Nothing kept yet and no network: the national hotlines shipped in the
  /// app plus the area's contacts from the last tenant config.
  bundled,
}

class EmergencySnapshot {
  const EmergencySnapshot({
    required this.page,
    required this.source,
    this.fetchedAt,
  });

  final EmergencyPage page;
  final EmergencySource source;
  final DateTime? fetchedAt;

  /// Due for a background refresh (`refreshAfterSeconds`); a bundled copy always is.
  bool isStaleAt(DateTime now) =>
      fetchedAt == null || now.difference(fetchedAt!) >= page.refreshAfter;
}

const bundledEmergencyAsset = 'assets/emergency/national_hotlines.json';

/// The emergency page, which must never fail (ADR 064): read from Drift
/// first, else the bundled hotlines (+ the tenant config's local contacts);
/// the network only ever *improves* what is shown. No method here throws.
class EmergencyRepository {
  EmergencyRepository(
    this._db,
    this._api, {
    Future<String> Function(String key)? loadAsset,
    DateTime Function()? now,
  }) : _loadAsset = loadAsset ?? rootBundle.loadString,
       _now = now ?? DateTime.now;

  final AppDatabase _db;
  final InfoApi _api;
  final Future<String> Function(String key) _loadAsset;
  final DateTime Function() _now;

  /// What to show right now, without the network.
  Future<EmergencySnapshot> local(String tenantId) async {
    try {
      final row = await (_db.select(
        _db.emergencyPageCache,
      )..where((t) => t.tenantId.equals(tenantId))).getSingleOrNull();
      if (row != null) {
        return EmergencySnapshot(
          page: EmergencyPage.fromJson(
            jsonDecode(row.json) as Map<String, dynamic>,
          ),
          source: EmergencySource.cached,
          fetchedAt: row.fetchedAt,
        );
      }
    } on Object {
      // A corrupt or unreadable copy: fall through to the bundled one.
    }
    return _bundled(tenantId);
  }

  /// Fetches the page and keeps it; null when the network (or the API) fails.
  Future<EmergencySnapshot?> refresh(
    String tenantId, {
    double? lat,
    double? lng,
  }) async {
    try {
      final json = await _api.emergencyJson(lat: lat, lng: lng);
      final page = EmergencyPage.fromJson(json);
      final at = _now();
      await _db
          .into(_db.emergencyPageCache)
          .insertOnConflictUpdate(
            EmergencyPageCacheCompanion.insert(
              tenantId: tenantId,
              version: page.version,
              json: jsonEncode(page.toJson()),
              fetchedAt: at,
            ),
          );
      return EmergencySnapshot(
        page: page,
        source: EmergencySource.live,
        fetchedAt: at,
      );
    } on Object {
      return null;
    }
  }

  /// The background refresh: only when the kept copy is due.
  Future<void> refreshIfStale(String tenantId) async {
    final current = await local(tenantId);
    if (current.isStaleAt(_now())) await refresh(tenantId);
  }

  Future<EmergencySnapshot> _bundled(String tenantId) async {
    var national = const <NationalHotline>[];
    try {
      final bundled = EmergencyPage.fromJson(
        jsonDecode(await _loadAsset(bundledEmergencyAsset))
            as Map<String, dynamic>,
      );
      national = bundled.national;
    } on Object {
      national = const [];
    }
    final groups = <String, List<LocalEmergencyContact>>{};
    try {
      final rows = await (_db.select(
        _db.emergencyContactCache,
      )..where((t) => t.tenantId.equals(tenantId))).get();
      for (final r in rows) {
        (groups[r.serviceType] ??= []).add(
          LocalEmergencyContact(
            id: '${r.rowId}',
            serviceType: r.serviceType,
            name: OptionalName(bn: r.nameBn, en: r.nameEn),
            phones: r.phones,
            is24h: r.is24h,
          ),
        );
      }
    } on Object {
      // No tenant config kept either: the national numbers alone.
    }
    return EmergencySnapshot(
      page: EmergencyPage(
        version: 'bundled',
        refreshAfter: Duration.zero,
        national: national,
        groups: [
          for (final e in groups.entries)
            EmergencyGroup(serviceType: e.key, contacts: e.value),
        ],
      ),
      source: EmergencySource.bundled,
    );
  }
}

final emergencyRepositoryProvider = Provider<EmergencyRepository>(
  (ref) => EmergencyRepository(
    ref.watch(appDatabaseProvider),
    ref.watch(infoApiProvider),
  ),
);
