import 'package:json_annotation/json_annotation.dart';

part 'otp_sent.g.dart';

/// Mirrors `OtpSentDto` (apps/api/src/auth/dto/auth-responses.dto.ts) — the
/// response to `POST /auth/otp/request`.
@JsonSerializable()
class OtpSent {
  const OtpSent({required this.status, required this.resendAfterSeconds});

  factory OtpSent.fromJson(Map<String, dynamic> json) =>
      _$OtpSentFromJson(json);

  final String status;

  /// Seconds until this phone may request another OTP — the server's
  /// `otp_resend_cooldown_seconds` setting.
  final int resendAfterSeconds;

  Map<String, dynamic> toJson() => _$OtpSentToJson(this);
}
