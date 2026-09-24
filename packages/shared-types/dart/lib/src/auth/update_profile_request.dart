import 'package:json_annotation/json_annotation.dart';

part 'update_profile_request.g.dart';

/// Mirrors `updateProfileSchema` (apps/api/src/auth/dto/update-profile.dto.ts)
/// — the body of `PATCH /auth/me`. Both fields are omit-to-leave-unchanged,
/// so this is built with [toJson] only including what's actually being
/// updated (json_serializable's `includeIfNull: false` on the nullable field).
@JsonSerializable(includeIfNull: false)
class UpdateProfileRequest {
  const UpdateProfileRequest({this.displayName, this.avatarStorageKey});

  factory UpdateProfileRequest.fromJson(Map<String, dynamic> json) =>
      _$UpdateProfileRequestFromJson(json);

  final String? displayName;
  final String? avatarStorageKey;

  Map<String, dynamic> toJson() => _$UpdateProfileRequestToJson(this);
}
