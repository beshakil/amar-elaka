import 'package:json_annotation/json_annotation.dart';

import 'device.dart';

part 'email_login_request.g.dart';

/// Mirrors `emailLoginSchema` (apps/api/src/auth/dto/email-login.dto.ts).
/// `POST /auth/email/register`'s body is `{email, password}` only (no
/// `device` — see [EmailRegisterRequest]), not the same shape as this one.
@JsonSerializable()
class EmailLoginRequest {
  const EmailLoginRequest({
    required this.email,
    required this.password,
    required this.device,
  });

  factory EmailLoginRequest.fromJson(Map<String, dynamic> json) =>
      _$EmailLoginRequestFromJson(json);

  final String email;
  final String password;
  final Device device;

  Map<String, dynamic> toJson() => _$EmailLoginRequestToJson(this);
}
