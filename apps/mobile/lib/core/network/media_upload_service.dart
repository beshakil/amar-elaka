import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import 'api_exception.dart';
import 'dio_client.dart';

part 'media_upload_service.g.dart';

/// The presign → PUT → confirm flow every media upload uses
/// (apps/api/src/storage: `POST /media/uploads`, a direct `PUT` to the
/// returned presigned URL, `POST /media/uploads/:id/confirm`) — generic
/// over [MediaKind] so it's reusable beyond the avatar upload it's built
/// for first (post media later).
class MediaUploadService {
  MediaUploadService(this._dio);

  final Dio _dio;

  /// Uploads [file] as [kind] and returns the confirmed `storageKey`.
  Future<String> upload(
    File file, {
    required MediaKind kind,
    required String contentType,
  }) async {
    final bytes = await file.readAsBytes();
    final checksum = sha256.convert(bytes).toString();

    try {
      final createResponse = await _dio.post<Map<String, dynamic>>(
        '/media/uploads',
        data: CreateUploadRequest(
          kind: kind,
          contentType: contentType,
          byteSize: bytes.length,
          checksumSha256: checksum,
        ).toJson(),
      );
      final created = CreateUploadResult.fromJson(createResponse.data!);

      final putDio = Dio();
      await putDio.put<void>(
        created.upload.url,
        data: Stream.fromIterable([bytes]),
        options: Options(
          headers: {
            ...created.upload.headers,
            Headers.contentLengthHeader: bytes.length,
          },
        ),
      );

      await _dio.post<void>('/media/uploads/${created.id}/confirm');
      return created.storageKey;
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }
}

@riverpod
MediaUploadService mediaUploadService(Ref ref) {
  return MediaUploadService(ref.watch(dioClientProvider));
}
