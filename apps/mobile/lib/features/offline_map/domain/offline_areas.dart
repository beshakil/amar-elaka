/// One cached area outline (from `GET /map/offline/areas`).
class OfflineArea {
  const OfflineArea({
    required this.id,
    required this.level,
    required this.admLevel,
    required this.nameBn,
    required this.nameEn,
    required this.polygons,
  });

  final String id;
  final String level;
  final int admLevel;
  final String? nameBn;
  final String nameEn;

  /// MultiPolygon: polygons → rings → [lng, lat] points (ring 0 the outline, the rest holes).
  final List<List<List<List<double>>>> polygons;

  String name(String locale) => locale == 'bn' ? (nameBn ?? nameEn) : nameEn;
}

/// Names a point without a network: which of the downloaded area outlines
/// contain it (the even-odd rule over each ring), most specific first — the
/// LocationPicker's area line offline (ADR 050).
class OfflineAreaIndex {
  OfflineAreaIndex(this.areas);

  /// Parses the GeoJSON FeatureCollection the API sent; bad features are skipped.
  factory OfflineAreaIndex.fromGeoJson(Map<String, dynamic> collection) {
    final areas = <OfflineArea>[];
    for (final raw in (collection['features'] as List? ?? const [])) {
      try {
        final feature = raw as Map<String, dynamic>;
        final props = feature['properties'] as Map<String, dynamic>;
        final geometry = feature['geometry'] as Map<String, dynamic>;
        final coords = geometry['coordinates'] as List;
        final polygons = switch (geometry['type']) {
          'MultiPolygon' => coords.map(_polygon).toList(),
          'Polygon' => [_polygon(coords)],
          _ => const <List<List<List<double>>>>[],
        };
        areas.add(
          OfflineArea(
            id: props['id'] as String,
            level: props['level'] as String,
            admLevel: (props['adm_level'] as num).toInt(),
            nameBn: props['name_bn'] as String?,
            nameEn: props['name_en'] as String,
            polygons: polygons,
          ),
        );
      } on Object {
        continue;
      }
    }
    return OfflineAreaIndex(areas);
  }

  final List<OfflineArea> areas;

  static List<List<List<double>>> _polygon(dynamic rings) => [
    for (final ring in rings as List)
      [
        for (final point in ring as List)
          [
            (point as List)[0] as num,
            point[1] as num,
          ].map((n) => n.toDouble()).toList(),
      ],
  ];

  /// Areas containing the point, the most specific (deepest level) first.
  List<OfflineArea> at(double lat, double lng) {
    final hits =
        areas
            .where((a) => a.polygons.any((p) => _inPolygon(p, lat, lng)))
            .toList()
          ..sort((a, b) => b.admLevel.compareTo(a.admLevel));
    return hits;
  }

  /// "Union, Upazila" in the reader's script, or null when outside them all.
  String? label(double lat, double lng, String locale) {
    final hits = at(lat, lng);
    return hits.isEmpty
        ? null
        : hits.take(2).map((a) => a.name(locale)).join(', ');
  }

  static bool _inPolygon(
    List<List<List<double>>> rings,
    double lat,
    double lng,
  ) {
    if (rings.isEmpty || !_inRing(rings.first, lat, lng)) return false;
    for (final hole in rings.skip(1)) {
      if (_inRing(hole, lat, lng)) return false;
    }
    return true;
  }

  static bool _inRing(List<List<double>> ring, double lat, double lng) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      final xi = ring[i][0], yi = ring[i][1];
      final xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) != (yj > lat) &&
          lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
}
