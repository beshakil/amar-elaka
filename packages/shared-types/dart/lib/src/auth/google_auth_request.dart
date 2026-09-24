import 'package:json_annotation/json_annotation.dart';

import 'device.dart';

part 'google_auth_request.g.dart';

/// Mirrors `googleAuthSchema` (apps/api/src/auth/dto/google-auth.dto.ts) —
/// the body of `POST /auth/google`, used both unauthenticated (sign in with
/// an already-linked Google account) and authenticated (link Google to the
/// caller's own account) — see `AuthService.googleAuth`'s dual-mode comment.
@JsonSerializable()
class GoogleAuthRequest {
  const GoogleAuthRequest({required this.idToken, required this.device});

  factory GoogleAuthRequest.fromJson(Map<String, dynamic> json) =>
      _$GoogleAuthRequestFromJson(json);

  final String idToken;
  final Device device;

  Map<String, dynamic> toJson() => _$GoogleAuthRequestToJson(this);
}
