import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The three primitives [SecureSessionStorage] needs — narrow on purpose so
/// tests can supply an in-memory fake instead of driving the real
/// `flutter_secure_storage` platform channel (which isn't available in
/// plain `flutter_test` unit tests).
abstract class SecureStoreBackend {
  Future<String?> read({required String key});
  Future<void> write({required String key, required String value});
  Future<void> delete({required String key});
}

class _FlutterSecureStorageBackend implements SecureStoreBackend {
  const _FlutterSecureStorageBackend();

  static const _storage = FlutterSecureStorage();

  @override
  Future<String?> read({required String key}) => _storage.read(key: key);

  @override
  Future<void> write({required String key, required String value}) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete({required String key}) => _storage.delete(key: key);
}

/// Session persistence — access/refresh tokens and the chosen tenant id
/// (Keystore/Keychain-backed). Nothing else in the app reads
/// `flutter_secure_storage` directly — interceptors, `AuthController` and
/// `TenantBootstrapController` go through this.
class SecureSessionStorage {
  SecureSessionStorage({SecureStoreBackend? backend})
    : _backend = backend ?? const _FlutterSecureStorageBackend();

  static const _accessTokenKey = 'auth.access_token';
  static const _refreshTokenKey = 'auth.refresh_token';
  static const _tenantIdKey = 'tenant.id';

  final SecureStoreBackend _backend;

  Future<String?> readAccessToken() => _backend.read(key: _accessTokenKey);

  Future<String?> readRefreshToken() => _backend.read(key: _refreshTokenKey);

  Future<void> saveSession({
    required String accessToken,
    required String refreshToken,
  }) async {
    await _backend.write(key: _accessTokenKey, value: accessToken);
    await _backend.write(key: _refreshTokenKey, value: refreshToken);
  }

  Future<void> clearSession() async {
    await _backend.delete(key: _accessTokenKey);
    await _backend.delete(key: _refreshTokenKey);
  }

  Future<String?> readTenantId() => _backend.read(key: _tenantIdKey);

  Future<void> saveTenantId(String tenantId) =>
      _backend.write(key: _tenantIdKey, value: tenantId);

  Future<void> clearTenantId() => _backend.delete(key: _tenantIdKey);
}
