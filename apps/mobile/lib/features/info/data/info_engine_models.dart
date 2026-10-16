/// The info engine's detail payloads (apps/api/src/info-engine/dto/info-engine.dto.ts,
/// ADR 065). Lists are `InfoCard`s (amar_elaka_api).
library;

import 'package:amar_elaka_api/amar_elaka_api.dart';

OptionalName _name(Object? json) =>
    OptionalName.fromJson((json as Map?)?.cast<String, dynamic>() ?? const {});

DateTime? _at(Object? v) => v is String ? DateTime.parse(v) : null;

({double lat, double lng})? _point(Object? json) => switch (json) {
  {'lat': final num lat, 'lng': final num lng} => (
    lat: lat.toDouble(),
    lng: lng.toDouble(),
  ),
  _ => null,
};

List<InfoCard> infoCards(Map<String, dynamic> json) => [
  for (final c in json['items'] as List)
    InfoCard.fromJson(c as Map<String, dynamic>),
];

class Attachment {
  const Attachment({
    required this.id,
    required this.isImage,
    required this.mimeType,
    required this.url,
  });

  factory Attachment.fromJson(Map<String, dynamic> json) => Attachment(
    id: json['id'] as String,
    isImage: json['kind'] == 'image',
    mimeType: json['mimeType'] as String,
    url: json['url'] as String,
  );

  final String id;
  final bool isImage;
  final String mimeType;
  final String url;
}

List<Attachment> _attachments(Object? list) => [
  for (final a in list as List? ?? const [])
    Attachment.fromJson(a as Map<String, dynamic>),
];

class NoticeDetail {
  const NoticeDetail({
    required this.card,
    required this.type,
    required this.category,
    required this.body,
    required this.isOfficial,
    required this.templateFields,
    required this.attachments,
    this.issuerName,
    this.template,
    this.expiresAt,
    this.publishedAt,
    this.areaName,
  });

  factory NoticeDetail.fromJson(Map<String, dynamic> json) => NoticeDetail(
    card: InfoCard.fromJson(json['card'] as Map<String, dynamic>),
    type: json['type'] as String,
    category: json['category'] as String,
    body: json['body'] as String,
    issuerName: json['issuerName'] as String?,
    isOfficial: json['isOfficial'] as bool? ?? false,
    template: json['template'] as String?,
    templateFields:
        (json['templateFields'] as Map?)?.cast<String, dynamic>() ?? {},
    expiresAt: _at(json['expiresAt']),
    publishedAt: _at(json['publishedAt']),
    areaName: json['areaName'] as String?,
    attachments: _attachments(json['attachments']),
  );

  final InfoCard card;
  final String type;
  final String category;
  final String body;
  final String? issuerName;
  final bool isOfficial;
  final String? template;
  final Map<String, dynamic> templateFields;
  final DateTime? expiresAt;
  final DateTime? publishedAt;
  final String? areaName;
  final List<Attachment> attachments;
}

class LostFoundDetail {
  const LostFoundDetail({
    required this.card,
    required this.kind,
    required this.itemType,
    required this.status,
    required this.isMine,
    required this.photos,
    this.description,
    this.locationText,
    this.lastSeenAt,
    this.reward,
  });

  factory LostFoundDetail.fromJson(Map<String, dynamic> json) =>
      LostFoundDetail(
        card: InfoCard.fromJson(json['card'] as Map<String, dynamic>),
        kind: json['kind'] as String,
        itemType: json['itemType'] as String,
        description: json['description'] as String?,
        locationText: json['locationText'] as String?,
        lastSeenAt: _at(json['lastSeenAt']),
        reward: json['reward'] as String?,
        status: json['status'] as String,
        isMine: json['isMine'] as bool? ?? false,
        photos: _attachments(json['photos']),
      );

  final InfoCard card;
  final String kind;
  final String itemType;
  final String? description;
  final String? locationText;
  final DateTime? lastSeenAt;
  final String? reward;
  final String status;
  final bool isMine;
  final List<Attachment> photos;
}

class RouteStop {
  const RouteStop({
    required this.seq,
    required this.name,
    this.minutesFromOrigin,
    this.fareFromOrigin,
  });

  final int seq;
  final OptionalName name;
  final int? minutesFromOrigin;
  final String? fareFromOrigin;
}

class RouteSchedule {
  const RouteSchedule({
    required this.direction,
    required this.departureTime,
    required this.days,
    this.serviceClass,
    this.fare,
  });

  final String direction;

  /// HH:MM in the area's time.
  final String departureTime;
  final List<int> days;
  final String? serviceClass;
  final String? fare;
}

class RouteDetail {
  const RouteDetail({
    required this.card,
    required this.mode,
    required this.originName,
    required this.destinationName,
    required this.contactPhones,
    required this.stops,
    required this.schedules,
    required this.next,
    this.operatorName,
    this.fareMin,
    this.fareMax,
    this.fareUpdatedOn,
    this.lastVerifiedAt,
    this.typicalDurationMinutes,
    this.notes,
  });

  factory RouteDetail.fromJson(Map<String, dynamic> json) => RouteDetail(
    card: InfoCard.fromJson(json['card'] as Map<String, dynamic>),
    mode: json['mode'] as String,
    operatorName: json['operatorName'] as String?,
    originName: json['originName'] as String,
    destinationName: json['destinationName'] as String,
    fareMin: json['fareMin'] as String?,
    fareMax: json['fareMax'] as String?,
    fareUpdatedOn: json['fareUpdatedOn'] as String?,
    lastVerifiedAt: _at(json['lastVerifiedAt']),
    typicalDurationMinutes: (json['typicalDurationMinutes'] as num?)?.toInt(),
    contactPhones: [for (final p in json['contactPhones'] as List) p as String],
    notes: json['notes'] as String?,
    stops: [
      for (final s in json['stops'] as List)
        RouteStop(
          seq: ((s as Map)['seq'] as num).toInt(),
          name: _name(s['name']),
          minutesFromOrigin: (s['minutesFromOrigin'] as num?)?.toInt(),
          fareFromOrigin: s['fareFromOrigin'] as String?,
        ),
    ],
    schedules: [
      for (final s in json['schedules'] as List)
        RouteSchedule(
          direction: (s as Map)['direction'] as String,
          departureTime: s['departureTime'] as String,
          days: [for (final d in s['days'] as List) (d as num).toInt()],
          serviceClass: s['serviceClass'] as String?,
          fare: s['fare'] as String?,
        ),
    ],
    next: [
      for (final d in json['nextDepartures'] as List)
        (
          at: DateTime.parse((d as Map)['departsAt'] as String),
          direction: d['direction'] as String,
          serviceClass: d['serviceClass'] as String?,
          fare: d['fare'] as String?,
        ),
    ],
  );

  final InfoCard card;
  final String mode;
  final String? operatorName;
  final String originName;
  final String destinationName;
  final String? fareMin;
  final String? fareMax;
  final String? fareUpdatedOn;
  final DateTime? lastVerifiedAt;
  final int? typicalDurationMinutes;
  final List<String> contactPhones;
  final String? notes;
  final List<RouteStop> stops;
  final List<RouteSchedule> schedules;
  final List<
    ({DateTime at, String direction, String? serviceClass, String? fare})
  >
  next;
}

class GovVersion {
  const GovVersion({
    required this.versionNo,
    required this.name,
    required this.officeName,
    required this.documents,
    required this.fees,
    required this.steps,
    required this.links,
    required this.createdAt,
    this.summary,
    this.officePlaceId,
    this.address,
    this.location,
    this.hours,
    this.changeNote,
  });

  factory GovVersion.fromJson(Map<String, dynamic> json) => GovVersion(
    versionNo: (json['versionNo'] as num).toInt(),
    name: _name(json['name']),
    summary: json['summary'] as String?,
    officeName: json['officeName'] as String,
    officePlaceId: json['officePlaceId'] as String?,
    address: json['address'] as String?,
    location: _point(json['location']),
    hours: json['hours'] as String?,
    documents: [for (final d in json['documents'] as List) d as String],
    fees: [
      for (final f in json['fees'] as List)
        (label: (f as Map)['label'] as String, amount: f['amount'] as String),
    ],
    steps: [for (final s in json['steps'] as List) s as String],
    links: [
      for (final l in json['links'] as List)
        (label: (l as Map)['label'] as String, url: l['url'] as String),
    ],
    changeNote: json['changeNote'] as String?,
    createdAt: DateTime.parse(json['createdAt'] as String),
  );

  final int versionNo;
  final OptionalName name;
  final String? summary;
  final String officeName;
  final String? officePlaceId;
  final String? address;
  final ({double lat, double lng})? location;
  final String? hours;
  final List<String> documents;
  final List<({String label, String amount})> fees;
  final List<String> steps;
  final List<({String label, String url})> links;
  final String? changeNote;
  final DateTime createdAt;
}

class GovServiceDetail {
  const GovServiceDetail({
    required this.card,
    required this.slug,
    required this.category,
    required this.lastVerifiedOn,
    required this.current,
    required this.versions,
  });

  factory GovServiceDetail.fromJson(Map<String, dynamic> json) =>
      GovServiceDetail(
        card: InfoCard.fromJson(json['card'] as Map<String, dynamic>),
        slug: json['slug'] as String,
        category: json['category'] as String,
        lastVerifiedOn: json['lastVerifiedOn'] as String,
        current: GovVersion.fromJson(json['current'] as Map<String, dynamic>),
        versions: [
          for (final v in json['versions'] as List)
            (
              versionNo: ((v as Map)['versionNo'] as num).toInt(),
              createdAt: DateTime.parse(v['createdAt'] as String),
              changeNote: v['changeNote'] as String?,
            ),
        ],
      );

  final InfoCard card;
  final String slug;
  final String category;
  final String lastVerifiedOn;
  final GovVersion current;
  final List<({int versionNo, DateTime createdAt, String? changeNote})>
  versions;
}

/// How the area calculates prayer times (on the device, ADR 065).
class PrayerSettings {
  const PrayerSettings({
    required this.method,
    required this.asrSchool,
    required this.hijriAdjustDays,
    required this.sehriCautionMinutes,
    required this.iftarCautionMinutes,
    this.lat,
    this.lng,
  });

  factory PrayerSettings.fromJson(Map<String, dynamic> json) {
    final center = _point(json['center']);
    return PrayerSettings(
      method: json['method'] as String? ?? 'karachi',
      asrSchool: json['asrSchool'] as String? ?? 'hanafi',
      hijriAdjustDays: (json['hijriAdjustDays'] as num?)?.toInt() ?? 0,
      sehriCautionMinutes: (json['sehriCautionMinutes'] as num?)?.toInt() ?? 0,
      iftarCautionMinutes: (json['iftarCautionMinutes'] as num?)?.toInt() ?? 0,
      lat: center?.lat,
      lng: center?.lng,
    );
  }

  /// Before the area has ever been asked: Bangladesh's usual way.
  static const fallback = PrayerSettings(
    method: 'karachi',
    asrSchool: 'hanafi',
    hijriAdjustDays: 0,
    sehriCautionMinutes: 0,
    iftarCautionMinutes: 0,
  );

  final String method;
  final String asrSchool;
  final int hijriAdjustDays;
  final int sehriCautionMinutes;
  final int iftarCautionMinutes;
  final double? lat;
  final double? lng;

  Map<String, dynamic> toJson() => {
    'method': method,
    'asrSchool': asrSchool,
    'hijriAdjustDays': hijriAdjustDays,
    'sehriCautionMinutes': sehriCautionMinutes,
    'iftarCautionMinutes': iftarCautionMinutes,
    'center': lat == null || lng == null ? null : {'lat': lat, 'lng': lng},
  };
}
