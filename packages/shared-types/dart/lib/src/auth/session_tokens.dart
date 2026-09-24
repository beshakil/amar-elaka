import 'package:json_annotation/json_annotation.dart';

part 'session_tokens.g.dart';

/// Mirrors `SessionTokens` (apps/api/src/auth/auth.service.ts) — the
/// response body of every login/refresh endpoint.
@JsonSerializable()
class SessionTokens {
  const SessionTokens({required this.accessToken, required this.refreshToken});

  factory SessionTokens.fromJson(Map<String, dynamic> json) =>
      _$SessionTokensFromJson(json);

  final String accessToken;
  final String refreshToken;

  Map<String, dynamic> toJson() => _$SessionTokensToJson(this);
}
