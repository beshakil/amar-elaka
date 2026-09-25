import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import 'api_exception.dart';
import 'dio_client.dart';

part 'media_upload_service.g.dart';

/// A single presign → PUT → confirm upload (apps/api/src/media:
/// `POST /media/presign`, a direct `PUT` to the returned presigned URL,
/// `POST /media/:id/confirm`), used for the profile avatar. Post photos go
/// through the compressing, resumable queue in features/media_upload.
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
        '/media/presign',
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

      await _dio.post<void>('/media/${created.id}/confirm');
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
