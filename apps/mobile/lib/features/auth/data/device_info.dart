import 'dart:io' show Platform;

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/foundation.dart' show kIsWeb;

/// Just the platform for now — `appVersion`/`deviceModel`/`fingerprintHash`/
/// `pushToken` stay null until there's a real need for them (package_info_plus
/// / device_info_plus / push notifications aren't part of the Week 3 shell).
Device currentDevice() {
  return Device(platformCode: _currentPlatform());
}

DevicePlatform _currentPlatform() {
  if (kIsWeb) return DevicePlatform.web;
  return Platform.isIOS ? DevicePlatform.ios : DevicePlatform.android;
}
