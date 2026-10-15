/// Bans, appeals and complaints as the API sends them (apps/api/src/bans, ADR 063).
library;

enum BanSeverity { restricted, banned, terminated }

BanSeverity banSeverityOf(Object? code) => switch (code) {
  'terminated' => BanSeverity.terminated,
  'banned' => BanSeverity.banned,
  _ => BanSeverity.restricted,
};

/// The person never sees an escalation: their appeal is "waiting" until final.
enum AppealStatus { waiting, granted, reduced, upheld, withdrawn }

AppealStatus appealStatusOf(Object? code) => switch (code) {
  'granted' => AppealStatus.granted,
  'reduced' => AppealStatus.reduced,
  'upheld' => AppealStatus.upheld,
  'withdrawn' => AppealStatus.withdrawn,
  _ => AppealStatus.waiting,
};

DateTime? _date(Object? value) => switch (value) {
  final String s => DateTime.parse(s),
  _ => null,
};

/// One ban as its notice shows it: why (a reason code — never the internal
/// text), how long, which area (its name, never a person), the reference.
class BanNotice {
  const BanNotice({
    required this.id,
    required this.platform,
    required this.reference,
    required this.severity,
    required this.reasonCode,
    required this.areaNameBn,
    required this.areaNameEn,
    required this.startsAt,
    required this.expiresAt,
    required this.permanent,
    required this.appealReference,
    required this.appealStatus,
    required this.canAppeal,
  });

  factory BanNotice.fromJson(Map<String, dynamic> json) {
    final area = json['areaName'] as Map<String, dynamic>?;
    final appeal = json['appeal'] as Map<String, dynamic>?;
    return BanNotice(
      id: json['id'] as String,
      platform: json['kind'] == 'platform',
      reference: json['reference'] as String,
      severity: banSeverityOf(json['severity']),
      reasonCode: json['reasonCode'] as String,
      areaNameBn: area?['bn'] as String?,
      areaNameEn: area?['en'] as String?,
      startsAt: DateTime.parse(json['startsAt'] as String),
      expiresAt: _date(json['expiresAt']),
      permanent: json['permanent'] as bool? ?? false,
      appealReference: appeal?['reference'] as String?,
      appealStatus: appeal == null ? null : appealStatusOf(appeal['status']),
      canAppeal: json['canAppeal'] as bool? ?? false,
    );
  }

  final String id;

  /// The global blacklist (every area) rather than one area's ban.
  final bool platform;
  final String reference;
  final BanSeverity severity;
  final String reasonCode;
  final String? areaNameBn;
  final String? areaNameEn;
  final DateTime startsAt;
  final DateTime? expiresAt;
  final bool permanent;
  final String? appealReference;
  final AppealStatus? appealStatus;
  final bool canAppeal;

  String? areaName(String locale) =>
      locale == 'en' ? (areaNameEn ?? areaNameBn) : areaNameBn;
}

List<BanNotice> banNoticesOf(Object? items) => [
  for (final item in items as List? ?? const [])
    BanNotice.fromJson(item as Map<String, dynamic>),
];

/// The public path's answer: the notices, today's appeals left, and the
/// short-lived token that lets the appeal follow without a second SMS.
class PublicAppealStatus {
  const PublicAppealStatus({
    required this.items,
    required this.appealsLeftToday,
    required this.appealToken,
  });

  factory PublicAppealStatus.fromJson(Map<String, dynamic> json) =>
      PublicAppealStatus(
        items: banNoticesOf(json['items']),
        appealsLeftToday: (json['appealsLeftToday'] as num?)?.toInt() ?? 0,
        appealToken: json['appealToken'] as String,
      );

  final List<BanNotice> items;
  final int appealsLeftToday;
  final String appealToken;
}

enum ComplaintCategory { fakeSeller, scam, abuse, other }

String complaintCategoryCode(ComplaintCategory c) => switch (c) {
  ComplaintCategory.fakeSeller => 'fake_seller',
  ComplaintCategory.scam => 'scam',
  ComplaintCategory.abuse => 'abuse',
  ComplaintCategory.other => 'other',
};

ComplaintCategory complaintCategoryOf(Object? code) => switch (code) {
  'fake_seller' => ComplaintCategory.fakeSeller,
  'scam' => ComplaintCategory.scam,
  'abuse' => ComplaintCategory.abuse,
  _ => ComplaintCategory.other,
};

class MyComplaint {
  const MyComplaint({
    required this.id,
    required this.reference,
    required this.subjectName,
    required this.category,
    required this.resolved,
    required this.inProgress,
    required this.createdAt,
  });

  factory MyComplaint.fromJson(Map<String, dynamic> json) => MyComplaint(
    id: json['id'] as String,
    reference: json['reference'] as String,
    subjectName: json['subjectName'] as String?,
    category: complaintCategoryOf(json['category']),
    resolved: json['status'] == 'resolved',
    inProgress: json['status'] == 'in_progress',
    createdAt: DateTime.parse(json['createdAt'] as String),
  );

  final String id;
  final String reference;
  final String? subjectName;
  final ComplaintCategory category;
  final bool resolved;
  final bool inProgress;
  final DateTime createdAt;
}
