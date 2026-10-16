import '../feed/feed.dart' show OptionalName;

/// The info engine's one card (apps/api/src/info-engine/dto/info-engine.dto.ts,
/// ADR 065): every list and feed card of a local information type. Badges
/// are codes the app names in its own strings.
class InfoCard {
  const InfoCard({
    required this.type,
    required this.id,
    required this.tenantId,
    required this.title,
    required this.badges,
    required this.isStale,
    this.summary,
    this.startsAt,
    this.endsAt,
    this.updatedAt,
    this.distanceMeters,
    this.lat,
    this.lng,
    this.imageUrl,
    this.imageThumbhash,
  });

  factory InfoCard.fromJson(Map<String, dynamic> json) {
    final location = json['location'] as Map<String, dynamic>?;
    final image = json['image'] as Map<String, dynamic>?;
    DateTime? at(String key) => switch (json[key]) {
      final String s => DateTime.parse(s),
      _ => null,
    };
    return InfoCard(
      type: json['type'] as String,
      id: json['id'] as String,
      tenantId: json['tenantId'] as String,
      title: OptionalName.fromJson(json['title'] as Map<String, dynamic>),
      summary: json['summary'] as String?,
      badges: [for (final b in json['badges'] as List) b as String],
      startsAt: at('startsAt'),
      endsAt: at('endsAt'),
      updatedAt: at('updatedAt'),
      isStale: json['isStale'] as bool? ?? false,
      distanceMeters: (json['distanceMeters'] as num?)?.toDouble(),
      lat: (location?['lat'] as num?)?.toDouble(),
      lng: (location?['lng'] as num?)?.toDouble(),
      imageUrl: image?['url'] as String?,
      imageThumbhash: image?['thumbhash'] as String?,
    );
  }

  /// outage | outage_report | notice | lost_found | transport | gov_service | directory.
  final String type;
  final String id;
  final String tenantId;
  final OptionalName title;
  final String? summary;
  final List<String> badges;
  final DateTime? startsAt;
  final DateTime? endsAt;
  final DateTime? updatedAt;
  final bool isStale;
  final double? distanceMeters;
  final double? lat;
  final double? lng;
  final String? imageUrl;
  final String? imageThumbhash;

  bool has(String badge) => badges.contains(badge);

  Map<String, dynamic> toJson() => {
    'type': type,
    'id': id,
    'tenantId': tenantId,
    'title': title.toJson(),
    'summary': summary,
    'badges': badges,
    'startsAt': startsAt?.toIso8601String(),
    'endsAt': endsAt?.toIso8601String(),
    'updatedAt': updatedAt?.toIso8601String(),
    'isStale': isStale,
    'distanceMeters': distanceMeters,
    'location': lat == null || lng == null ? null : {'lat': lat, 'lng': lng},
    'image': imageUrl == null
        ? null
        : {'url': imageUrl, 'thumbhash': imageThumbhash},
  };
}
