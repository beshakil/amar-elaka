import 'package:json_annotation/json_annotation.dart';

part 'otp_request_body.g.dart';

/// Mirrors `otpRequestSchema` (apps/api/src/auth/dto/otp-request.dto.ts).
@JsonSerializable()
class OtpRequestBody {
  const OtpRequestBody({required this.phone});

  factory OtpRequestBody.fromJson(Map<String, dynamic> json) =>
      _$OtpRequestBodyFromJson(json);

  final String phone;

  Map<String, dynamic> toJson() => _$OtpRequestBodyToJson(this);
}
