import 'package:json_annotation/json_annotation.dart';

part 'me_result.g.dart';

/// Mirrors `MeResult` (apps/api/src/auth/auth.service.ts) — the body of `GET /auth/me`.
///
/// `role` is left as a plain string rather than a closed enum: it spans both
/// platform roles (platform_admin, ...) and tenant-membership roles (member,
/// agent, ...) from `AppRole` (apps/api/src/database/tenant-context.ts), and
/// the app doesn't branch on most of them yet.
@JsonSerializable()
class MeResult {
  const MeResult({
    required this.userId,
    required this.phone,
    required this.email,
    required this.displayName,
    required this.avatarStorageKey,
    required this.tenantId,
    required this.memberId,
    required this.role,
  });

  factory MeResult.fromJson(Map<String, dynamic> json) =>
      _$MeResultFromJson(json);

  final String userId;
  final String phone;
  final String? email;
  final String displayName;
  final String? avatarStorageKey;
  final String tenantId;
  final String memberId;
  final String role;

  Map<String, dynamic> toJson() => _$MeResultToJson(this);
}
