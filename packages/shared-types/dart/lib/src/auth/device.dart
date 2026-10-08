import 'package:json_annotation/json_annotation.dart';

part 'device.g.dart';

/// Mirrors `deviceSchema` (apps/api/src/auth/dto/device.schema.ts). Unknown
/// fields are left out, never sent as null: the API takes a string or
/// nothing, and a null failed every phone login (found on a device, 0049).
@JsonSerializable(includeIfNull: false)
class Device {
  const Device({
    required this.platformCode,
    this.appVersion,
    this.deviceModel,
    this.fingerprintHash,
    this.pushToken,
  });

  factory Device.fromJson(Map<String, dynamic> json) => _$DeviceFromJson(json);

  final DevicePlatform platformCode;
  final String? appVersion;
  final String? deviceModel;
  final String? fingerprintHash;
  final String? pushToken;

  Map<String, dynamic> toJson() => _$DeviceToJson(this);
}

enum DevicePlatform { android, ios, web }
