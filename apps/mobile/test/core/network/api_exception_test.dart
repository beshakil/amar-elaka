import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

DioException _dioError({
  required DioExceptionType type,
  int? statusCode,
  Object? responseData,
}) {
  final requestOptions = RequestOptions(path: '/test');
  return DioException(
    requestOptions: requestOptions,
    type: type,
    response: statusCode == null
        ? null
        : Response(
            requestOptions: requestOptions,
            statusCode: statusCode,
            data: responseData,
          ),
  );
}

void main() {
  group('mapDioException', () {
    test('maps timeouts to TimeoutException', () {
      expect(
        mapDioException(_dioError(type: DioExceptionType.connectionTimeout)),
        isA<TimeoutException>(),
      );
      expect(
        mapDioException(_dioError(type: DioExceptionType.receiveTimeout)),
        isA<TimeoutException>(),
      );
    });

    test('maps connection errors to NetworkException', () {
      expect(
        mapDioException(_dioError(type: DioExceptionType.connectionError)),
        isA<NetworkException>(),
      );
    });

    test('parses a real backend error body into ApiException', () {
      final error = _dioError(
        type: DioExceptionType.badResponse,
        statusCode: 401,
        responseData: {
          'statusCode': 401,
          'error': 'UNAUTHENTICATED',
          'message': 'Invalid or expired token',
        },
      );

      final result = mapDioException(error);

      expect(result, isA<ApiException>());
      final apiException = result as ApiException;
      expect(apiException.statusCode, 401);
      expect(apiException.code, 'UNAUTHENTICATED');
      expect(apiException.message, 'Invalid or expired token');
      expect(apiException.validationIssues, isNull);
    });

    test('parses VALIDATION_FAILED details into typed issues', () {
      final error = _dioError(
        type: DioExceptionType.badResponse,
        statusCode: 400,
        responseData: {
          'statusCode': 400,
          'error': 'VALIDATION_FAILED',
          'message': 'Request validation failed',
          'details': [
            {'path': 'email', 'message': 'Invalid email'},
          ],
        },
      );

      final result = mapDioException(error) as ApiException;

      expect(result.validationIssues, hasLength(1));
      expect(result.validationIssues!.single.path, 'email');
      expect(result.validationIssues!.single.message, 'Invalid email');
    });

    test('falls back to UnknownApiException for an unparseable body', () {
      final error = _dioError(
        type: DioExceptionType.badResponse,
        statusCode: 500,
        responseData: 'oops',
      );
      expect(mapDioException(error), isA<UnknownApiException>());
    });
  });
}
