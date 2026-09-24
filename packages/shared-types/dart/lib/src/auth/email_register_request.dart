import 'package:json_annotation/json_annotation.dart';

part 'email_register_request.g.dart';

/// Mirrors `emailRegisterSchema` (apps/api/src/auth/dto/email-register.dto.ts)
/// — `POST /auth/email/register`'s body. No `device` field (unlike
/// [EmailLoginRequest]): this links a password to the caller's own
/// already-authenticated account, it doesn't start a session.
@JsonSerializable()
class EmailRegisterRequest {
  const EmailRegisterRequest({required this.email, required this.password});

  factory EmailRegisterRequest.fromJson(Map<String, dynamic> json) =>
      _$EmailRegisterRequestFromJson(json);

  final String email;
  final String password;

  Map<String, dynamic> toJson() => _$EmailRegisterRequestToJson(this);
}
