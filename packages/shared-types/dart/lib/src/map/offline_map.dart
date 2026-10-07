import 'package:json_annotation/json_annotation.dart';

part 'offline_map.g.dart';

/// Mirrors `OfflineMapManifestDto` (apps/api/src/map/offline/offline-map.dto.ts):
/// `GET /map/offline`, what "এলাকার ম্যাপ ডাউনলোড" downloads — this tenant's
/// archive (cut from our own Bangladesh .pmtiles, ADR 050), the fonts and
/// sprites the style reads, the points to keep and how often to check for
/// a newer version.
@JsonSerializable(explicitToJson: true)
class OfflineMapManifest {
  const OfflineMapManifest({
    required this.available,
    required this.reason,
    required this.archive,
    required this.assets,
    required this.assetsBytes,
    required this.totalBytes,
    required this.pointSets,
    required this.labelLanguage,
    required this.updateCheckHours,
  });

  factory OfflineMapManifest.fromJson(Map<String, dynamic> json) =>
      _$OfflineMapManifestFromJson(json);

  final bool available;

  /// not_built | too_large | failed — why [archive] is null.
  final String? reason;
  final OfflineArchive? archive;

  /// Glyph ranges, Bengali font files and sprites; [OfflineFile.path] is the
  /// path to keep them under, so the style's `{fontstack}/{range}` resolve.
  final List<OfflineFile> assets;
  final int assetsBytes;

  /// Archive + assets: what the screen shows before downloading.
  final int totalBytes;
  final List<OfflinePointSet> pointSets;

  /// `map_label_language`, kept so the offline style needs no `/map/config`.
  final String labelLanguage;
  final int updateCheckHours;

  Map<String, dynamic> toJson() => _$OfflineMapManifestToJson(this);
}

/// One downloadable file with what verifies it.
@JsonSerializable()
class OfflineFile {
  const OfflineFile({
    required this.path,
    required this.url,
    required this.bytes,
    required this.sha256,
  });

  factory OfflineFile.fromJson(Map<String, dynamic> json) =>
      _$OfflineFileFromJson(json);

  final String path;
  final String url;
  final int bytes;
  final String sha256;

  Map<String, dynamic> toJson() => _$OfflineFileToJson(this);
}

/// The tenant's archive: an [OfflineFile] plus its version and coverage.
@JsonSerializable()
class OfflineArchive extends OfflineFile {
  const OfflineArchive({
    required super.path,
    required super.url,
    required super.bytes,
    required super.sha256,
    required this.version,
    required this.maxZoom,
    required this.bounds,
    required this.builtAt,
  });

  factory OfflineArchive.fromJson(Map<String, dynamic> json) =>
      _$OfflineArchiveFromJson(json);

  /// The national version it was cut from: a different one is an update.
  final String version;
  final int maxZoom;

  /// [minLng, minLat, maxLng, maxLat]
  final List<double> bounds;
  final String builtAt;

  @override
  Map<String, dynamic> toJson() => _$OfflineArchiveToJson(this);
}

/// One `GET /map/features` query whose points are kept offline.
@JsonSerializable()
class OfflinePointSet {
  const OfflinePointSet({required this.layers, required this.kinds});

  factory OfflinePointSet.fromJson(Map<String, dynamic> json) =>
      _$OfflinePointSetFromJson(json);

  final List<String> layers;

  /// `map_kinds` codes; null = every kind.
  final List<String>? kinds;

  Map<String, dynamic> toJson() => _$OfflinePointSetToJson(this);
}
