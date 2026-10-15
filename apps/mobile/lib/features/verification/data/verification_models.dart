/// Verification as the API sends it (apps/api/src/verification, ADR 062).
library;

/// The badge levels, lowest first.
enum VerificationLevel {
  none,
  phoneVerified,
  identityChecked,
  businessVerified,
}

VerificationLevel verificationLevelOf(Object? code) => switch (code) {
  'phone_verified' => VerificationLevel.phoneVerified,
  'identity_checked' => VerificationLevel.identityChecked,
  'business_verified' => VerificationLevel.businessVerified,
  _ => VerificationLevel.none,
};

enum VerificationStatus {
  submitted,
  inReview,
  approved,
  rejected,
  expired,
  revoked,
}

VerificationStatus _status(Object? code) => switch (code) {
  'in_review' => VerificationStatus.inReview,
  'approved' => VerificationStatus.approved,
  'rejected' => VerificationStatus.rejected,
  'expired' => VerificationStatus.expired,
  'revoked' => VerificationStatus.revoked,
  _ => VerificationStatus.submitted,
};

/// Can a new request be made now (verification_can_request).
enum RequestState { ok, openRequest, alreadyVerified }

RequestState _request(Object? code) => switch (code) {
  'open_request' => RequestState.openRequest,
  'already_verified' => RequestState.alreadyVerified,
  _ => RequestState.ok,
};

class VerificationRequest {
  const VerificationRequest({
    required this.id,
    required this.status,
    required this.createdAt,
    this.rejectionReason,
    this.note,
    this.expiresAt,
  });

  factory VerificationRequest.fromJson(Map<String, dynamic> json) =>
      VerificationRequest(
        id: json['id'] as String,
        status: _status(json['status']),
        rejectionReason: json['rejectionReason'] as String?,
        note: json['note'] as String?,
        expiresAt: switch (json['expiresAt']) {
          final String s => DateTime.parse(s),
          _ => null,
        },
        createdAt: DateTime.parse(json['createdAt'] as String),
      );

  final String id;
  final VerificationStatus status;

  /// document_unclear | document_expired | name_mismatch | suspected_fraud | duplicate_submission | other
  final String? rejectionReason;

  /// The moderator's note to the applicant.
  final String? note;
  final DateTime? expiresAt;
  final DateTime createdAt;

  bool get isOpen =>
      status == VerificationStatus.submitted ||
      status == VerificationStatus.inReview;
}

List<VerificationRequest> _items(Object? list) => [
  for (final v in list as List? ?? const [])
    VerificationRequest.fromJson(v as Map<String, dynamic>),
];

class MyVerifications {
  const MyVerifications({
    required this.level,
    required this.request,
    required this.items,
  });

  factory MyVerifications.fromJson(Map<String, dynamic> json) =>
      MyVerifications(
        level: verificationLevelOf(json['level']),
        request: _request(json['identityRequest']),
        items: _items(json['items']),
      );

  final VerificationLevel level;
  final RequestState request;

  /// Newest first.
  final List<VerificationRequest> items;
}

class StoreVerification {
  const StoreVerification({
    required this.level,
    required this.request,
    required this.ownerIdentityChecked,
    required this.items,
  });

  factory StoreVerification.fromJson(Map<String, dynamic> json) =>
      StoreVerification(
        level: verificationLevelOf(json['level']),
        request: _request(json['request']),
        ownerIdentityChecked: json['ownerIdentityChecked'] as bool? ?? false,
        items: _items(json['items']),
      );

  final VerificationLevel level;
  final RequestState request;
  final bool ownerIdentityChecked;
  final List<VerificationRequest> items;
}

/// The digits of an NID number (Bengali digits allowed, spaces and dashes
/// ignored), or null unless it has 10, 13 or 17 digits — the same check as
/// the API's (nid.ts), so a typo is caught before anything is sent.
String? normalizeNid(String input) {
  final ascii = input.replaceAllMapped(
    RegExp('[০-৯]'),
    (m) => String.fromCharCode(m[0]!.codeUnitAt(0) - 0x09E6 + 0x30),
  );
  final digits = ascii.replaceAll(RegExp(r'[\s-]'), '');
  if (!RegExp(r'^\d+$').hasMatch(digits)) return null;
  return const {10, 13, 17}.contains(digits.length) ? digits : null;
}
