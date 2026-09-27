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

  /// Confirms the upload and returns once the photo is `ready` to attach to
  /// a post (the API refuses photos still `processing`).
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

  /// How often, and how long, to wait for the worker to make a confirmed
  /// photo ready (transport tuning: processing takes a second or two).
  static const readyPollInterval = Duration(milliseconds: 500);
  static const readyMaxPolls = 40;

  /// Confirm, then wait until the worker has made the photo `ready`: only
  /// then is it "done" — a post can't attach one still `processing`, and a
  /// seller who taps "post" right after the last upload must not get
  /// POST_MEDIA_INVALID. A photo the worker rejects fails here.
  @override
  Future<void> confirm(String mediaId) => _call(() async {
    var status = await _status(
      _api.post<Map<String, dynamic>>('/media/$mediaId/confirm'),
    );
    for (var poll = 0; status == 'processing' && poll < readyMaxPolls; poll++) {
      await Future<void>.delayed(readyPollInterval);
      status = await _status(_api.get<Map<String, dynamic>>('/media/$mediaId'));
    }
    switch (status) {
      case 'ready':
        return;
      case 'processing':
        throw const UploadFailure('processing_timeout', retryable: true);
      default:
        throw UploadFailure('media_$status', retryable: false);
    }
  });

  Future<String> _status(
    Future<Response<Map<String, dynamic>>> request,
  ) async => ((await request).data?['status'] as String?) ?? 'processing';

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
