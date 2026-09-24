import 'dart:async';
import 'dart:math';

import 'package:dio/dio.dart';

const _retryableMethods = {'GET', 'HEAD', 'DELETE'};
const _maxAttempts = 2;
const _baseDelay = Duration(milliseconds: 300);

/// Retries idempotent requests (GET/HEAD/DELETE only — POST/PATCH are never
/// retried automatically, to avoid double-submits) on network errors,
/// timeouts, or a 5xx response, with capped exponential backoff.
class RetryInterceptor extends Interceptor {
  RetryInterceptor(this._dio);

  final Dio _dio;

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) async {
    if (!_shouldRetry(err)) {
      handler.next(err);
      return;
    }

    final attempt = (err.requestOptions.extra['retryAttempt'] as int?) ?? 0;
    if (attempt >= _maxAttempts) {
      handler.next(err);
      return;
    }

    await Future<void>.delayed(_baseDelay * pow(2, attempt).toInt());

    try {
      final options = err.requestOptions;
      options.extra['retryAttempt'] = attempt + 1;
      final response = await _dio.fetch<dynamic>(options);
      handler.resolve(response);
    } on DioException catch (retryError) {
      handler.next(retryError);
    }
  }

  bool _shouldRetry(DioException err) {
    if (!_retryableMethods.contains(err.requestOptions.method.toUpperCase())) {
      return false;
    }
    switch (err.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
      case DioExceptionType.connectionError:
        return true;
      case DioExceptionType.badResponse:
        return (err.response?.statusCode ?? 0) >= 500;
      case DioExceptionType.cancel:
      case DioExceptionType.badCertificate:
      case DioExceptionType.unknown:
        return false;
    }
  }
}
