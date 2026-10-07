import 'dart:math' as math;

import 'package:amar_elaka_api/amar_elaka_api.dart';

import '../../../core/storage/app_database.dart';

/// The cached essential points (ADR 050) in [box] of the [kinds] (null:
/// every kind), shaped like `GET /map/features` so the Map tab draws them
/// the same way. Never clustered: an area's essentials are a few hundred.
MapFeatures offlineFeatures(
  List<OfflinePointRow> rows, {
  required ({double minLng, double minLat, double maxLng, double maxLat}) box,
  required double zoom,
  Set<String>? kinds,
}) {
  final features = [
    for (final row in rows)
      if (row.lng >= box.minLng &&
          row.lng <= box.maxLng &&
          row.lat >= box.minLat &&
          row.lat <= box.maxLat &&
          (kinds == null || (row.kind != null && kinds.contains(row.kind))))
        MapFeature(
          id: row.featureId,
          geometry: MapPointGeometry(coordinates: [row.lng, row.lat]),
          properties: MapFeatureProperties(
            cluster: false,
            layer: row.layer,
            kind: row.kind,
            id: row.featureId,
            tenantId: row.featureTenantId,
            nameBn: row.nameBn,
            nameEn: row.nameEn,
            infoKind: row.infoKind,
          ),
        ),
  ];
  return MapFeatures(
    zoom: zoom.floor(),
    layers: {for (final row in rows) row.layer}.toList()..sort(),
    clustered: false,
    clipped: false,
    truncated: false,
    openNowSkipped: const [],
    features: features,
  );
}

const _earthRadiusMeters = 6371008.8;

/// Great-circle metres: the straight-line distance without the network.
double haversineMeters(double lat1, double lng1, double lat2, double lng2) {
  double rad(double degrees) => degrees * math.pi / 180;
  final dLat = rad(lat2 - lat1);
  final dLng = rad(lng2 - lng1);
  final a =
      math.pow(math.sin(dLat / 2), 2) +
      math.cos(rad(lat1)) *
          math.cos(rad(lat2)) *
          math.pow(math.sin(dLng / 2), 2);
  return 2 * _earthRadiusMeters * math.asin(math.min(1, math.sqrt(a)));
}
