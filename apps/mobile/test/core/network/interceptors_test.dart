import 'dart:typed_data';

import 'package:amar_elaka_app/core/network/interceptors/auth_interceptor.dart';
import 'package:amar_elaka_app/core/network/interceptors/tenant_interceptor.dart';
import 'package:amar_elaka_app/core/storage/secure_session_storage.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

class _InMemoryBackend implements SecureStoreBackend {
  final Map<String, String> _values = {};

  @override
  Future<String?> read({required String key}) async => _values[key];

  @override
  Future<void> write({required String key, required String value}) async =>
      _values[key] = value;

  @override
  Future<void> delete({required String key}) async => _values.remove(key);
}

/// Captures the fully-processed `RequestOptions` (i.e. after all
/// interceptors ran) instead of making a real HTTP call.
class _CapturingAdapter implements HttpClientAdapter {
  RequestOptions? lastOptions;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    lastOptions = options;
    return ResponseBody.fromString(
      '{}',
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('TenantInterceptor', () {
    test('adds X-Tenant-Id when a tenant id is stored', () async {
      final storage = SecureSessionStorage(backend: _InMemoryBackend());
      await storage.saveTenantId('tenant-123');
      final adapter = _CapturingAdapter();
      final dio = Dio()
        ..httpClientAdapter = adapter
        ..interceptors.add(TenantInterceptor(storage));

      await dio.get('https://example.test/x');

      expect(adapter.lastOptions?.headers['X-Tenant-Id'], 'tenant-123');
    });

    test('adds nothing when no tenant id is stored', () async {
      final storage = SecureSessionStorage(backend: _InMemoryBackend());
      final adapter = _CapturingAdapter();
      final dio = Dio()
        ..httpClientAdapter = adapter
        ..interceptors.add(TenantInterceptor(storage));

      await dio.get('https://example.test/x');

      expect(adapter.lastOptions?.headers.containsKey('X-Tenant-Id'), isFalse);
    });
  });

  group('AuthInterceptor', () {
    test('adds Authorization from the stored access token', () async {
      final storage = SecureSessionStorage(backend: _InMemoryBackend());
      await storage.saveSession(accessToken: 'abc', refreshToken: 'def');
      final adapter = _CapturingAdapter();
      final dio = Dio()
        ..httpClientAdapter = adapter
        ..interceptors.add(AuthInterceptor(storage));

      await dio.get('https://example.test/x');

      expect(adapter.lastOptions?.headers['Authorization'], 'Bearer abc');
    });

    test(
      'skips the header when skipAuth is set, even with a stored token',
      () async {
        final storage = SecureSessionStorage(backend: _InMemoryBackend());
        await storage.saveSession(accessToken: 'abc', refreshToken: 'def');
        final adapter = _CapturingAdapter();
        final dio = Dio()
          ..httpClientAdapter = adapter
          ..interceptors.add(AuthInterceptor(storage));

        await dio.get(
          'https://example.test/x',
          options: Options(extra: {skipAuthKey: true}),
        );

        expect(
          adapter.lastOptions?.headers.containsKey('Authorization'),
          isFalse,
        );
      },
    );

    test('adds nothing when no token is stored', () async {
      final storage = SecureSessionStorage(backend: _InMemoryBackend());
      final adapter = _CapturingAdapter();
      final dio = Dio()
        ..httpClientAdapter = adapter
        ..interceptors.add(AuthInterceptor(storage));

      await dio.get('https://example.test/x');

      expect(
        adapter.lastOptions?.headers.containsKey('Authorization'),
        isFalse,
      );
    });
  });
}
