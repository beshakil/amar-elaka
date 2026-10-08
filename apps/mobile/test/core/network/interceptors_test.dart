import 'dart:typed_data';

import 'package:amar_elaka_app/core/network/interceptors/auth_interceptor.dart';
import 'package:amar_elaka_app/core/network/interceptors/refresh_interceptor.dart';
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

/// A tiny API: `/x` wants a fresh token, `/auth/refresh` issues one, and
/// every request is recorded with its headers.
class _ExpiringApi implements HttpClientAdapter {
  final requests = <RequestOptions>[];

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    final json = {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    };
    if (options.path.endsWith('/auth/refresh')) {
      if (options.headers['X-Tenant-Id'] == null) {
        return ResponseBody.fromString(
          '{"statusCode":400,"error":"TENANT_REQUIRED","message":"x"}',
          400,
          headers: json,
        );
      }
      return ResponseBody.fromString(
        '{"accessToken":"fresh","refreshToken":"r2"}',
        200,
        headers: json,
      );
    }
    final fresh = options.headers['Authorization'] == 'Bearer fresh';
    return ResponseBody.fromString(
      fresh ? '{"ok":true}' : '{"statusCode":401,"error":"UNAUTHENTICATED"}',
      fresh ? 200 : 401,
      headers: json,
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  group('RefreshInterceptor', () {
    test(
      'an expired token is refreshed in the tenant and the request replayed '
      'with the new one (both were missing: every session ended at 15 min)',
      () async {
        final storage = SecureSessionStorage(backend: _InMemoryBackend());
        await storage.saveTenantId('tenant-123');
        await storage.saveSession(accessToken: 'stale', refreshToken: 'r1');
        final api = _ExpiringApi();
        final refreshDio = Dio(BaseOptions(baseUrl: 'https://api.test'))
          ..httpClientAdapter = api;
        var expired = false;
        final dio = Dio(BaseOptions(baseUrl: 'https://api.test'))
          ..httpClientAdapter = api
          ..interceptors.addAll([
            TenantInterceptor(storage),
            AuthInterceptor(storage),
            RefreshInterceptor(
              refreshDio: refreshDio,
              storage: storage,
              onSessionExpired: () => expired = true,
            ),
          ]);

        final response = await dio.get<Map<String, dynamic>>('/x');

        expect(response.data, {'ok': true});
        expect(expired, isFalse);
        final refresh = api.requests.firstWhere(
          (r) => r.path.endsWith('/auth/refresh'),
        );
        expect(refresh.headers['X-Tenant-Id'], 'tenant-123');
        expect(api.requests.last.headers['Authorization'], 'Bearer fresh');
        expect(await storage.readAccessToken(), 'fresh');
        expect(await storage.readRefreshToken(), 'r2');
      },
    );
  });

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
