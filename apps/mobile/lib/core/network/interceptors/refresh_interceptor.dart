// Params are named publicly but store into private fields (`_refreshDio`,
// `_storage`), so `this._refreshDio`/`this._storage` initializing formals
// aren't an option — a private name can't be a named-parameter label.
// ignore_for_file: prefer_initializing_formals

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';

import '../../storage/secure_session_storage.dart';
import 'auth_interceptor.dart';

/// On a 401 from a request that *did* send an access token (i.e. not a
/// login/refresh call itself — those are `skipAuth`), refreshes once and
/// replays the original request. Concurrent 401s share the same in-flight
/// refresh via [_refreshFuture] (a `QueuedInterceptor` serializes calls into
/// this interceptor, but without this guard each queued call would still
/// kick off its own refresh). If refresh fails, the session is cleared and
/// [onSessionExpired] fires so the app can redirect to login — the original
/// 401 still propagates as a normal `ApiException` after that.
class RefreshInterceptor extends QueuedInterceptor {
  RefreshInterceptor({
    required Dio refreshDio,
    required SecureSessionStorage storage,
    required this.onSessionExpired,
  }) : _refreshDio = refreshDio,
       _storage = storage;

  /// A separate `Dio` (no interceptors of its own) for the refresh call
  /// itself, so it can't recursively trigger this interceptor.
  final Dio _refreshDio;
  final SecureSessionStorage _storage;
  final void Function() onSessionExpired;

  Future<bool>? _refreshFuture;

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    final isUnauthorized = err.response?.statusCode == 401;
    final sentAccessToken = err.requestOptions.extra[skipAuthKey] != true;
    if (!isUnauthorized || !sentAccessToken) {
      handler.next(err);
      return;
    }

    final refreshed = await (_refreshFuture ??= _refresh());
    if (!refreshed) {
      handler.next(err);
      return;
    }

    try {
      final response = await _refreshDio.fetch<dynamic>(err.requestOptions);
      handler.resolve(response);
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }

  Future<bool> _refresh() async {
    try {
      final refreshToken = await _storage.readRefreshToken();
      if (refreshToken == null) {
        onSessionExpired();
        return false;
      }

      final response = await _refreshDio.post<Map<String, dynamic>>(
        '/auth/refresh',
        data: RefreshRequestBody(refreshToken: refreshToken).toJson(),
        options: Options(extra: {skipAuthKey: true}),
      );
      final tokens = SessionTokens.fromJson(response.data!);
      await _storage.saveSession(
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      );
      return true;
    } on DioException {
      await _storage.clearSession();
      onSessionExpired();
      return false;
    } finally {
      _refreshFuture = null;
    }
  }
}
