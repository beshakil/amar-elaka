import 'package:json_annotation/json_annotation.dart';

import 'device.dart';

part 'otp_verify_body.g.dart';

/// Mirrors `otpVerifySchema` (apps/api/src/auth/dto/otp-verify.dto.ts).
@JsonSerializable()
class OtpVerifyBody {
  const OtpVerifyBody({
    required this.phone,
    required this.code,
    required this.device,
  });

  factory OtpVerifyBody.fromJson(Map<String, dynamic> json) =>
      _$OtpVerifyBodyFromJson(json);

  final String phone;
  final String code;
  final Device device;

  Map<String, dynamic> toJson() => _$OtpVerifyBodyToJson(this);
}
