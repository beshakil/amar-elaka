import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/auth/data/device_info.dart';
import 'package:flutter_test/flutter_test.dart';

/// The device block every login sends (`deviceSchema` in the API: each field
/// a string or absent). Sending the unknown ones as null made the API answer
/// VALIDATION_FAILED to every phone login on a real device.
void main() {
  test('unknown device fields are left out, never sent as null', () {
    final json = currentDevice().toJson();
    expect(json.keys, ['platformCode']);
    expect(json.values, isNot(contains(null)));
  });

  test('a login body carries no null anywhere', () {
    final body = OtpVerifyBody(
      phone: '+8801711000077',
      code: '760248',
      device: currentDevice(),
    ).toJson();
    final encoded = jsonEncode(body);
    expect(encoded, isNot(contains('null')));
    expect((jsonDecode(encoded) as Map<String, dynamic>)['device'], {
      'platformCode': 'android',
    });
  });

  test('known fields still go out', () {
    const device = Device(
      platformCode: DevicePlatform.android,
      appVersion: '1.0.0',
    );
    expect(device.toJson(), {'platformCode': 'android', 'appVersion': '1.0.0'});
  });
}
