import 'package:dio/dio.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../storage/secure_session_storage.dart';
import 'api_config.dart';
import 'interceptors/auth_interceptor.dart';
import 'interceptors/refresh_interceptor.dart';
import 'interceptors/retry_interceptor.dart';
import 'interceptors/tenant_interceptor.dart';
import 'session_signal.dart';

part 'dio_client.g.dart';

@riverpod
SecureSessionStorage secureSessionStorage(Ref ref) => SecureSessionStorage();

/// The app's single `Dio` instance. Interceptor order matters: tenant/auth
/// headers must be set before a request can fail with 401 for the refresh
/// interceptor to act on, and retry must see the *final* (possibly
/// refreshed-and-replayed) outcome.
@riverpod
Dio dioClient(Ref ref) {
  final storage = ref.watch(secureSessionStorageProvider);
  final baseOptions = BaseOptions(
    baseUrl: ApiConfig.baseUrl,
    connectTimeout: const Duration(seconds: 10),
    sendTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 15),
    contentType: 'application/json',
  );

  // No interceptors of its own: used by RefreshInterceptor for the refresh
  // call itself and to replay the original request, so a replay can't
  // recursively re-trigger this same chain.
  final refreshDio = Dio(baseOptions);

  final dio = Dio(baseOptions);
  dio.interceptors.addAll([
    TenantInterceptor(storage),
    AuthInterceptor(storage),
    RefreshInterceptor(
      refreshDio: refreshDio,
      storage: storage,
      onSessionExpired: () =>
          ref.read(sessionSignalProvider.notifier).notifyExpired(),
    ),
    RetryInterceptor(dio),
  ]);
  return dio;
}
