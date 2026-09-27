import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Sends `X-Install-Id`: a random id made once per install and kept in
/// SharedPreferences. The API uses it (hashed) to count a guest's views and
/// contact reveals once per device (apps/api/src/engagement/viewer-key.ts,
/// ADR 036). It identifies nothing else and is never tied to an account.
class InstallIdInterceptor extends Interceptor {
  InstallIdInterceptor({Future<String> Function()? installId})
    : _installId = installId ?? readOrCreateInstallId;

  final Future<String> Function() _installId;

  static const _key = 'install.id';

  static Future<String> readOrCreateInstallId() async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getString(_key);
    if (existing != null) return existing;
    final random = math.Random.secure();
    final id = List.generate(
      16,
      (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
    ).join();
    await prefs.setString(_key, id);
    return id;
  }

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    options.headers['X-Install-Id'] ??= await _installId();
    handler.next(options);
  }
}
