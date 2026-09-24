import 'package:json_annotation/json_annotation.dart';

part 'create_upload_request.g.dart';

enum MediaKind { image, video, document }

/// Mirrors `createUploadSchema` (apps/api/src/storage/dto/create-upload.dto.ts)
/// — the body of `POST /media/uploads`, step 1 of the presign → PUT →
/// confirm flow every media upload (avatar now, post media later) uses.
@JsonSerializable()
class CreateUploadRequest {
  const CreateUploadRequest({
    required this.kind,
    required this.contentType,
    required this.byteSize,
    required this.checksumSha256,
  });

  factory CreateUploadRequest.fromJson(Map<String, dynamic> json) =>
      _$CreateUploadRequestFromJson(json);

  final MediaKind kind;
  final String contentType;
  final int byteSize;

  /// Lowercase 64-character hex SHA-256 digest of the file bytes.
  final String checksumSha256;

  Map<String, dynamic> toJson() => _$CreateUploadRequestToJson(this);
}
