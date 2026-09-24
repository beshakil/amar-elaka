import 'package:json_annotation/json_annotation.dart';

part 'create_upload_result.g.dart';

/// Mirrors `PresignedUpload` (apps/api/src/storage/storage.ports.ts) — step
/// 2 of the upload flow: PUT the file bytes to [url] with [headers].
@JsonSerializable()
class PresignedUpload {
  const PresignedUpload({
    required this.url,
    required this.method,
    required this.headers,
    required this.expiresInSeconds,
  });

  factory PresignedUpload.fromJson(Map<String, dynamic> json) =>
      _$PresignedUploadFromJson(json);

  final String url;
  final String method;
  final Map<String, String> headers;
  final int expiresInSeconds;

  Map<String, dynamic> toJson() => _$PresignedUploadToJson(this);
}

/// Mirrors `CreateUploadResult` (apps/api/src/storage/media-uploads.service.ts)
/// — the response to `POST /media/uploads`. [id] is confirmed via
/// `POST /media/uploads/:id/confirm` after the PUT succeeds; [storageKey] is
/// what gets attached to whatever owns the upload (e.g. `PATCH /auth/me`'s
/// `avatarStorageKey`).
@JsonSerializable()
class CreateUploadResult {
  const CreateUploadResult({
    required this.id,
    required this.upload,
    required this.storageKey,
  });

  factory CreateUploadResult.fromJson(Map<String, dynamic> json) =>
      _$CreateUploadResultFromJson(json);

  final String id;
  final PresignedUpload upload;
  final String storageKey;

  Map<String, dynamic> toJson() => _$CreateUploadResultToJson(this);
}
