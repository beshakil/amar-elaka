import 'package:dio/dio.dart';

import '../../storage/secure_session_storage.dart';

/// Attaches `X-Tenant-Id` (apps/api/src/database/tenant-resolution.middleware.ts
/// reads this header first, ahead of subdomain/custom-domain resolution —
/// the mechanism a client with no hostname-based tenancy needs).
class TenantInterceptor extends Interceptor {
  TenantInterceptor(this._storage);

  final SecureSessionStorage _storage;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (!options.headers.containsKey('X-Tenant-Id')) {
      final tenantId = await _storage.readTenantId();
      if (tenantId != null) options.headers['X-Tenant-Id'] = tenantId;
    }
    handler.next(options);
  }
}
