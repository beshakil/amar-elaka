import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';

/// Typed replacement for raw `DioException` — the UI layer catches this,
/// never a Dio type, mirroring the backend's own "typed exceptions, no raw
/// leakage" rule (CLAUDE.md).
sealed class AppException implements Exception {
  const AppException(this.message);

  final String message;
}

/// No connection, DNS failure, connection reset, etc.
final class NetworkException extends AppException {
  const NetworkException([super.message = 'Network error']);
}

/// The request timed out (connect/send/receive).
final class TimeoutException extends AppException {
  const TimeoutException([super.message = 'Request timed out']);
}

/// A real HTTP error response, with the parsed body from
/// `apps/api/src/common/filters/global-exception.filter.ts`.
final class ApiException extends AppException {
  ApiException(this.body) : super(body.message);

  final ApiErrorBody body;

  int get statusCode => body.statusCode;
  String get code => body.error;
  List<ValidationIssue>? get validationIssues => body.validationIssues;
}

/// Anything else — a bug, an unparseable response, etc.
final class UnknownApiException extends AppException {
  const UnknownApiException([super.message = 'Something went wrong']);
}

/// Converts a `DioException` into an [AppException]. Used by the error
/// interceptor (attached last, after retry) and safe to call directly in a
/// repository's `catch (e) when (e is DioException)` too.
AppException mapDioException(DioException error) {
  switch (error.type) {
    case DioExceptionType.connectionTimeout:
    case DioExceptionType.sendTimeout:
    case DioExceptionType.receiveTimeout:
    case DioExceptionType.transformTimeout:
      return const TimeoutException();
    case DioExceptionType.connectionError:
      return const NetworkException();
    case DioExceptionType.cancel:
      return const UnknownApiException('Request cancelled');
    case DioExceptionType.badResponse:
      return _mapBadResponse(error);
    case DioExceptionType.badCertificate:
    case DioExceptionType.unknown:
      return const UnknownApiException();
  }
}

AppException _mapBadResponse(DioException error) {
  final data = error.response?.data;
  if (data is! Map<String, dynamic>) return const UnknownApiException();
  try {
    return ApiException(ApiErrorBody.fromJson(data));
  } on TypeError {
    return const UnknownApiException();
  }
}
