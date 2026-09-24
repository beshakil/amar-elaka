import 'package:json_annotation/json_annotation.dart';

part 'refresh_request_body.g.dart';

/// Mirrors `refreshSchema`/`logoutSchema` (apps/api/src/auth/dto/refresh.dto.ts)
/// — both endpoints take the same single-field body.
@JsonSerializable()
class RefreshRequestBody {
  const RefreshRequestBody({required this.refreshToken});

  factory RefreshRequestBody.fromJson(Map<String, dynamic> json) =>
      _$RefreshRequestBodyFromJson(json);

  final String refreshToken;

  Map<String, dynamic> toJson() => _$RefreshRequestBodyToJson(this);
}
