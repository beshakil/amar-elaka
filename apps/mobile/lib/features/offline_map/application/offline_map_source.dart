import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/connectivity_provider.dart';
import '../../../core/storage/app_database.dart';
import 'offline_map_controller.dart';
import 'offline_map_prefs.dart';

/// Where the base map reads its tiles, fonts and sprites from when the
/// downloaded area is in use (ADR 050): plain `file://` URLs on this phone.
class LocalMapSource {
  const LocalMapSource({
    required this.tilesUrl,
    required this.assetsBaseUrl,
    required this.labelLanguage,
  });

  factory LocalMapSource.of(OfflineMapRow row) => LocalMapSource(
    tilesUrl: Uri.file(row.archivePath).toString(),
    assetsBaseUrl: Uri.file(row.assetsDir).toString(),
    labelLanguage: row.labelLanguage,
  );

  /// The archive (the style adds `pmtiles://` in front).
  final String tilesUrl;
  final String assetsBaseUrl;
  final String labelLanguage;
}

/// The downloaded map, when there is one and either the user prefers it or
/// there's no connection; null: the server's map (`GET /map/config`).
/// BaseMap also falls back to it whenever /map/config fails.
final localMapSourceProvider = Provider<LocalMapSource?>((ref) {
  final row = ref.watch(installedOfflineMapProvider).value;
  if (row == null) return null;
  final useDownloaded =
      ref.watch(offlineMapPrefsProvider).value?.useDownloadedMap ?? true;
  final online = ref.watch(isOnlineProvider).value ?? true;
  return useDownloaded || !online ? LocalMapSource.of(row) : null;
});

/// Downloaded but unused right now (online, and the user prefers the
/// server's map): BaseMap still falls back to it when /map/config fails.
final installedLocalMapSourceProvider = Provider<LocalMapSource?>((ref) {
  final row = ref.watch(installedOfflineMapProvider).value;
  return row == null ? null : LocalMapSource.of(row);
});
