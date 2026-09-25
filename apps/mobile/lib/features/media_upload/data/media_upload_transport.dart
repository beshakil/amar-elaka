import 'dart:io';

import 'package:dio/dio.dart';

import '../../../core/network/api_exception.dart';

/// Where to PUT the file, and the mediaId to confirm afterwards.
class PresignedTarget {
  const PresignedTarget({
    required this.mediaId,
    required this.url,
    required this.headers,
  });

  final String mediaId;
  final String url;
  final Map<String, String> headers;
}

/// A failed step. [retryable] = worth trying again later (network, timeout,
/// storage hiccup); not retryable = the file or request itself was refused.
class UploadFailure implements Exception {
  const UploadFailure(this.code, {required this.retryable});

  final String code;
  final bool retryable;

  @override
  String toString() => 'UploadFailure($code, retryable: $retryable)';
}

/// The three calls of the media pipeline (apps/api/src/media). The file's
/// bytes go straight to object storage, never through the API.
abstract interface class MediaUploadTransport {
  Future<PresignedTarget> presign({
    required int byteSize,
    required String sha256,
    required String contentType,
  });

  Future<void> put(
    PresignedTarget target,
    File file, {
    required void Function(double progress) onProgress,
    CancelToken? cancelToken,
  });

  Future<void> confirm(String mediaId);
}

class DioMediaUploadTransport implements MediaUploadTransport {
  DioMediaUploadTransport(this._api)
    : _storage = Dio(
        BaseOptions(
          connectTimeout: const Duration(seconds: 15),
          // Generous: a slow 3G uplink moves ~150 KB in well under this.
          sendTimeout: const Duration(minutes: 2),
          receiveTimeout: const Duration(seconds: 30),
        ),
      );

  /// The authenticated API client (dio_client.dart).
  final Dio _api;

  /// A bare client for the presigned PUT: no auth or tenant headers, which
  /// would break the signature.
  final Dio _storage;

  @override
  Future<PresignedTarget> presign({
    required int byteSize,
    required String sha256,
    required String contentType,
  }) => _call(() async {
    final response = await _api.post<Map<String, dynamic>>(
      '/media/presign',
      data: {
        'kind': 'image',
        'contentType': contentType,
        'byteSize': byteSize,
        'checksumSha256': sha256,
      },
    );
    final body = response.data!;
    final upload = body['upload'] as Map<String, dynamic>;
    return PresignedTarget(
      mediaId: body['id'] as String,
      url: upload['url'] as String,
      headers: Map<String, String>.from(upload['headers'] as Map),
    );
  });

  @override
  Future<void> put(
    PresignedTarget target,
    File file, {
    required void Function(double progress) onProgress,
    CancelToken? cancelToken,
  }) => _call(() async {
    final length = await file.length();
    await _storage.put<void>(
      target.url,
      data: file.openRead(),
      cancelToken: cancelToken,
      options: Options(
        headers: {...target.headers, Headers.contentLengthHeader: length},
      ),
      onSendProgress: (sent, total) {
        if (total > 0) onProgress(sent / total);
      },
    );
  });

  @override
  Future<void> confirm(String mediaId) =>
      _call(() => _api.post<void>('/media/$mediaId/confirm'));

  Future<T> _call<T>(Future<T> Function() work) async {
    try {
      return await work();
    } on DioException catch (error) {
      if (CancelToken.isCancel(error)) {
        throw const UploadFailure('cancelled', retryable: false);
      }
      final mapped = mapDioException(error);
      throw switch (mapped) {
        // Refused for what the file is (type, size, not an image): don't retry.
        ApiException(:final statusCode, :final code)
            when statusCode >= 400 && statusCode < 500 && statusCode != 408 =>
          UploadFailure(
            code,
            retryable: statusCode == 429 || statusCode == 409,
          ),
        ApiException(:final code) => UploadFailure(code, retryable: true),
        _ => const UploadFailure('network', retryable: true),
      };
    }
  }
}
