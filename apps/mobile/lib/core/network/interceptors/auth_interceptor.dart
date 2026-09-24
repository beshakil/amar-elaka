import 'package:dio/dio.dart';

import '../../storage/secure_session_storage.dart';

/// Requests that don't take (or don't need) an access token — otp
/// request/verify, refresh itself, and the tenant-agnostic tenant list —
/// set this in `Options.extra` to skip the header entirely instead of
/// sending a stale/absent Bearer token.
const skipAuthKey = 'skipAuth';

/// Attaches `Authorization: Bearer <accessToken>` from [SecureSessionStorage].
class AuthInterceptor extends Interceptor {
  AuthInterceptor(this._storage);

  final SecureSessionStorage _storage;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (options.extra[skipAuthKey] == true) {
      handler.next(options);
      return;
    }
    final token = await _storage.readAccessToken();
    if (token != null) options.headers['Authorization'] = 'Bearer $token';
    handler.next(options);
  }
}
