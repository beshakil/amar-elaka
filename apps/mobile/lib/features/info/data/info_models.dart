/// Local information services as the API sends them
/// (apps/api/src/info/dto/info.dto.ts, ADR 064).
library;

import 'package:amar_elaka_api/amar_elaka_api.dart';

OptionalName _name(Object? json) =>
    OptionalName.fromJson((json as Map?)?.cast<String, dynamic>() ?? const {});

({double lat, double lng})? _point(Object? json) => switch (json) {
  {'lat': final num lat, 'lng': final num lng} => (
    lat: lat.toDouble(),
    lng: lng.toDouble(),
  ),
  _ => null,
};

// ---- emergency -------------------------------------------------------------

class NationalHotline {
  const NationalHotline({
    required this.id,
    required this.serviceType,
    required this.name,
    required this.description,
    required this.dial,
  });

  factory NationalHotline.fromJson(Map<String, dynamic> json) =>
      NationalHotline(
        id: json['id'] as String,
        serviceType: json['serviceType'] as String,
        name: _name(json['name']),
        description: _name(json['description']),
        dial: json['dial'] as String,
      );

  final String id;
  final String serviceType;
  final OptionalName name;
  final OptionalName description;
  final String dial;

  Map<String, dynamic> toJson() => {
    'id': id,
    'serviceType': serviceType,
    'name': name.toJson(),
    'description': description.toJson(),
    'dial': dial,
  };
}

class LocalEmergencyContact {
  const LocalEmergencyContact({
    required this.id,
    required this.serviceType,
    required this.name,
    required this.phones,
    required this.is24h,
    this.address,
    this.location,
    this.availabilityNote,
    this.distanceMeters,
  });

  factory LocalEmergencyContact.fromJson(Map<String, dynamic> json) =>
      LocalEmergencyContact(
        id: json['id'] as String,
        serviceType: json['serviceType'] as String,
        name: _name(json['name']),
        phones: [for (final p in json['phones'] as List) p as String],
        is24h: json['is24h'] as bool? ?? false,
        address: json['address'] as String?,
        location: _point(json['location']),
        availabilityNote: json['availabilityNote'] as String?,
        distanceMeters: (json['distanceMeters'] as num?)?.toDouble(),
      );

  final String id;
  final String serviceType;
  final OptionalName name;
  final List<String> phones;
  final bool is24h;
  final String? address;
  final ({double lat, double lng})? location;
  final String? availabilityNote;
  final double? distanceMeters;

  Map<String, dynamic> toJson() => {
    'id': id,
    'serviceType': serviceType,
    'name': name.toJson(),
    'phones': phones,
    'is24h': is24h,
    'address': address,
    'location': location == null
        ? null
        : {'lat': location!.lat, 'lng': location!.lng},
    'availabilityNote': availabilityNote,
    'distanceMeters': distanceMeters,
  };
}

class EmergencyGroup {
  const EmergencyGroup({required this.serviceType, required this.contacts});

  factory EmergencyGroup.fromJson(Map<String, dynamic> json) => EmergencyGroup(
    serviceType: json['serviceType'] as String,
    contacts: [
      for (final c in json['contacts'] as List)
        LocalEmergencyContact.fromJson(c as Map<String, dynamic>),
    ],
  );

  final String serviceType;
  final List<LocalEmergencyContact> contacts;

  Map<String, dynamic> toJson() => {
    'serviceType': serviceType,
    'contacts': [for (final c in contacts) c.toJson()],
  };
}

/// GET /info/emergency — kept whole in Drift so it opens with no network.
class EmergencyPage {
  const EmergencyPage({
    required this.version,
    required this.refreshAfter,
    required this.national,
    required this.groups,
  });

  factory EmergencyPage.fromJson(Map<String, dynamic> json) => EmergencyPage(
    version: json['version'] as String,
    refreshAfter: Duration(
      seconds: (json['refreshAfterSeconds'] as num?)?.toInt() ?? 0,
    ),
    national: [
      for (final h in json['national'] as List)
        NationalHotline.fromJson(h as Map<String, dynamic>),
    ],
    groups: [
      for (final g in json['groups'] as List)
        EmergencyGroup.fromJson(g as Map<String, dynamic>),
    ],
  );

  final String version;
  final Duration refreshAfter;
  final List<NationalHotline> national;
  final List<EmergencyGroup> groups;

  Map<String, dynamic> toJson() => {
    'version': version,
    'refreshAfterSeconds': refreshAfter.inSeconds,
    'national': [for (final h in national) h.toJson()],
    'groups': [for (final g in groups) g.toJson()],
  };
}

// ---- bazar -------------------------------------------------------------------

class PriceRange {
  const PriceRange({required this.min, required this.max});

  static PriceRange? fromJson(Object? json) => switch (json) {
    {'min': final String min, 'max': final String max} => PriceRange(
      min: min,
      max: max,
    ),
    _ => null,
  };

  final String min;
  final String max;
}

class TrendPoint {
  const TrendPoint({required this.date, required this.range});

  final String date;
  final PriceRange range;
}

enum PriceDirection { up, down, same }

PriceDirection? _direction(Object? code) => switch (code) {
  'up' => PriceDirection.up,
  'down' => PriceDirection.down,
  'same' => PriceDirection.same,
  _ => null,
};

class BazarBoardItem {
  const BazarBoardItem({
    required this.commodityId,
    required this.code,
    required this.name,
    required this.group,
    required this.unit,
    required this.trend,
    this.today,
    this.yesterday,
    this.direction,
  });

  factory BazarBoardItem.fromJson(Map<String, dynamic> json) => BazarBoardItem(
    commodityId: json['commodityId'] as String,
    code: json['code'] as String,
    name: _name(json['name']),
    group: json['group'] as String,
    unit: json['unit'] as String,
    today: PriceRange.fromJson(json['today']),
    yesterday: PriceRange.fromJson(json['yesterday']),
    direction: _direction(json['direction']),
    trend: [
      for (final t in json['trend'] as List)
        switch (t) {
          {'date': final String date} => TrendPoint(
            date: date,
            range: PriceRange.fromJson(t)!,
          ),
          _ => null,
        },
    ],
  );

  final String commodityId;
  final String code;
  final OptionalName name;
  final String group;
  final String unit;
  final PriceRange? today;
  final PriceRange? yesterday;
  final PriceDirection? direction;

  /// One slot per day, oldest first; null where nothing was entered.
  final List<TrendPoint?> trend;

  /// The newest figure on the board (today's, else the latest in the trend).
  PriceRange? get latest =>
      today ?? trend.lastWhere((t) => t != null, orElse: () => null)?.range;
}

class BazarSponsor {
  const BazarSponsor({required this.name, this.tagline, this.linkUrl});

  final OptionalName name;
  final String? tagline;
  final String? linkUrl;
}

class BazarBoard {
  const BazarBoard({
    required this.date,
    required this.isStale,
    required this.items,
    this.lastUpdated,
    this.sponsor,
  });

  factory BazarBoard.fromJson(Map<String, dynamic> json) {
    final sponsor = json['sponsor'] as Map<String, dynamic>?;
    return BazarBoard(
      date: json['date'] as String,
      lastUpdated: json['lastUpdated'] as String?,
      isStale: json['isStale'] as bool,
      sponsor: sponsor == null
          ? null
          : BazarSponsor(
              name: _name(sponsor['name']),
              tagline: sponsor['tagline'] as String?,
              linkUrl: sponsor['linkUrl'] as String?,
            ),
      items: [
        for (final i in json['items'] as List)
          BazarBoardItem.fromJson(i as Map<String, dynamic>),
      ],
    );
  }

  final String date;
  final String? lastUpdated;
  final bool isStale;
  final BazarSponsor? sponsor;
  final List<BazarBoardItem> items;
}

class BazarEntryItem {
  const BazarEntryItem({
    required this.commodityId,
    required this.name,
    required this.group,
    required this.unit,
    this.entered,
    this.previous,
  });

  factory BazarEntryItem.fromJson(Map<String, dynamic> json) => BazarEntryItem(
    commodityId: json['commodityId'] as String,
    name: _name(json['name']),
    group: json['group'] as String,
    unit: json['unit'] as String,
    entered: PriceRange.fromJson(json['entered']),
    previous: PriceRange.fromJson(json['previous']),
  );

  final String commodityId;
  final OptionalName name;
  final String group;
  final String unit;
  final PriceRange? entered;
  final PriceRange? previous;
}

/// GET /bazar/entry: the fast entry sheet.
class BazarEntrySheet {
  const BazarEntrySheet({
    required this.date,
    required this.earliestDate,
    required this.items,
  });

  factory BazarEntrySheet.fromJson(Map<String, dynamic> json) =>
      BazarEntrySheet(
        date: json['date'] as String,
        earliestDate: json['earliestDate'] as String,
        items: [
          for (final i in json['items'] as List)
            BazarEntryItem.fromJson(i as Map<String, dynamic>),
        ],
      );

  final String date;
  final String earliestDate;
  final List<BazarEntryItem> items;
}

class BazarEntryLine {
  const BazarEntryLine({
    required this.commodityId,
    required this.unit,
    required this.min,
    required this.max,
  });

  final String commodityId;
  final String unit;
  final String min;
  final String max;

  Map<String, dynamic> toJson() => {
    'commodityId': commodityId,
    'unitCode': unit,
    'minPrice': min,
    'maxPrice': max,
  };
}

// ---- blood -------------------------------------------------------------------

const bloodGroups = [
  'a_pos',
  'a_neg',
  'b_pos',
  'b_neg',
  'ab_pos',
  'ab_neg',
  'o_pos',
  'o_neg',
];
const contactWindows = ['any', 'morning', 'afternoon', 'evening', 'daytime'];
const urgencyLevels = ['critical', 'urgent', 'planned'];

/// "B+": the same symbol in Bengali and English.
String bloodGroupSymbol(String code) => switch (code) {
  'a_pos' => 'A+',
  'a_neg' => 'A-',
  'b_pos' => 'B+',
  'b_neg' => 'B-',
  'ab_pos' => 'AB+',
  'ab_neg' => 'AB-',
  'o_pos' => 'O+',
  'o_neg' => 'O-',
  _ => code,
};

class DonorCard {
  const DonorCard({
    required this.id,
    required this.bloodGroup,
    required this.distanceMeters,
    required this.contactWindow,
    required this.sharesNumber,
    this.displayName,
    this.area,
  });

  factory DonorCard.fromJson(Map<String, dynamic> json) => DonorCard(
    id: json['id'] as String,
    bloodGroup: json['bloodGroup'] as String,
    displayName: json['displayName'] as String?,
    area: json['area'] == null ? null : _name(json['area']),
    distanceMeters: (json['distanceMeters'] as num).toDouble(),
    contactWindow: json['contactWindow'] as String,
    sharesNumber: json['contactPreference'] == 'reveal_on_request',
  );

  final String id;
  final String bloodGroup;
  final String? displayName;
  final OptionalName? area;
  final double distanceMeters;
  final String contactWindow;

  /// A call is possible; otherwise the donor is asked in-app.
  final bool sharesNumber;
}

class DonorPage {
  const DonorPage({required this.items, required this.radiusKm, this.next});

  factory DonorPage.fromJson(Map<String, dynamic> json) => DonorPage(
    items: [
      for (final d in json['items'] as List)
        DonorCard.fromJson(d as Map<String, dynamic>),
    ],
    radiusKm: (json['radiusKm'] as num).toDouble(),
    next: json['next'] as String?,
  );

  final List<DonorCard> items;
  final double radiusKm;
  final String? next;
}

class MyDonor {
  const MyDonor({
    required this.bloodGroup,
    required this.isAvailable,
    required this.isListed,
    required this.contactWindow,
    required this.sharesNumber,
    required this.alertsEnabled,
    required this.contactsToday,
    required this.dailyContactCap,
    this.location,
    this.lastDonatedOn,
    this.eligibleFrom,
  });

  static MyDonor? fromJson(Map<String, dynamic> json) {
    final d = json['donor'] as Map<String, dynamic>?;
    if (d == null) return null;
    return MyDonor(
      bloodGroup: d['bloodGroup'] as String,
      location: _point(d['location']),
      lastDonatedOn: d['lastDonatedOn'] as String?,
      eligibleFrom: d['eligibleFrom'] as String?,
      isAvailable: d['isAvailable'] as bool,
      isListed: d['isListed'] as bool,
      contactWindow: d['contactWindow'] as String,
      sharesNumber: d['contactPreference'] == 'reveal_on_request',
      alertsEnabled: d['alertsEnabled'] as bool,
      contactsToday: (d['contactsToday'] as num).toInt(),
      dailyContactCap: (d['dailyContactCap'] as num).toInt(),
    );
  }

  final String bloodGroup;
  final ({double lat, double lng})? location;
  final String? lastDonatedOn;
  final String? eligibleFrom;
  final bool isAvailable;
  final bool isListed;
  final String contactWindow;
  final bool sharesNumber;
  final bool alertsEnabled;
  final int contactsToday;
  final int dailyContactCap;
}

class DonorContactEntry {
  const DonorContactEntry({
    required this.id,
    required this.at,
    required this.channel,
    this.requesterName,
    this.request,
  });

  factory DonorContactEntry.fromJson(Map<String, dynamic> json) =>
      DonorContactEntry(
        id: json['id'] as String,
        at: DateTime.parse(json['at'] as String),
        requesterName: json['requesterName'] as String?,
        channel: json['channel'] as String,
        request: switch (json['request']) {
          final Map<String, dynamic> r => BloodRequestCard(
            id: r['id'] as String,
            bloodGroup: r['bloodGroup'] as String,
            units: 1,
            hospitalName: r['hospitalName'] as String,
            neededBy: DateTime.parse(r['neededBy'] as String),
            urgency: 'urgent',
            status: r['status'] as String,
            isMine: false,
          ),
          _ => null,
        },
      );

  final String id;
  final DateTime at;
  final String? requesterName;

  /// donor_request: asked in-app; otherwise they took the number.
  final String channel;
  final BloodRequestCard? request;
}

class BloodRequestCard {
  const BloodRequestCard({
    required this.id,
    required this.bloodGroup,
    required this.units,
    required this.hospitalName,
    required this.neededBy,
    required this.urgency,
    required this.status,
    required this.isMine,
    this.distanceMeters,
  });

  factory BloodRequestCard.fromJson(Map<String, dynamic> json) =>
      BloodRequestCard(
        id: json['id'] as String,
        bloodGroup: json['bloodGroup'] as String,
        units: (json['units'] as num).toInt(),
        hospitalName: json['hospitalName'] as String,
        neededBy: DateTime.parse(json['neededBy'] as String),
        urgency: json['urgency'] as String,
        status: json['status'] as String,
        isMine: json['isMine'] as bool? ?? false,
        distanceMeters: (json['distanceMeters'] as num?)?.toDouble(),
      );

  final String id;
  final String bloodGroup;
  final int units;
  final String hospitalName;
  final DateTime neededBy;
  final String urgency;
  final String status;
  final bool isMine;
  final double? distanceMeters;
}

class BloodRequestDetail {
  const BloodRequestDetail({
    required this.card,
    this.patientNote,
    this.requesterName,
    this.location,
    this.alertedDonors,
  });

  factory BloodRequestDetail.fromJson(Map<String, dynamic> json) =>
      BloodRequestDetail(
        card: BloodRequestCard.fromJson(json),
        patientNote: json['patientNote'] as String?,
        requesterName: json['requesterName'] as String?,
        location: _point(json['location']),
        alertedDonors: (json['alertedDonors'] as num?)?.toInt(),
      );

  final BloodRequestCard card;
  final String? patientNote;
  final String? requesterName;
  final ({double lat, double lng})? location;
  final int? alertedDonors;
}

/// What a contact tap opens: a tel:/sms:/wa.me link, or "asked" in-app.
class ContactOutcome {
  const ContactOutcome({this.href});

  final String? href;
  bool get asked => href == null;
}
