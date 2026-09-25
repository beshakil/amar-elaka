/// One photo in an upload queue, from picking to a confirmed `mediaId`.
///
/// Persisted as JSON (upload_queue_store.dart) so a queue survives the app
/// being killed; `compressedPath` points at the compressed copy kept in the
/// app's support directory until the upload is confirmed.
enum UploadStatus {
  /// Waiting for a free upload slot.
  queued,
  compressing,
  uploading,

  /// Uploaded; the API is checking it (POST /media/:id/confirm).
  confirming,
  done,

  /// Gave up after retries; the user can retry.
  failed,
}

class UploadItem {
  const UploadItem({
    required this.id,
    required this.sourcePath,
    this.compressedPath,
    this.status = UploadStatus.queued,
    this.progress = 0,
    this.mediaId,
    this.attempts = 0,
    this.byteSize,
    this.errorCode,
  });

  factory UploadItem.fromJson(Map<String, dynamic> json) => UploadItem(
    id: json['id'] as String,
    sourcePath: json['sourcePath'] as String,
    compressedPath: json['compressedPath'] as String?,
    status: UploadStatus.values.byName(json['status'] as String),
    progress: (json['progress'] as num?)?.toDouble() ?? 0,
    mediaId: json['mediaId'] as String?,
    attempts: json['attempts'] as int? ?? 0,
    byteSize: json['byteSize'] as int?,
    errorCode: json['errorCode'] as String?,
  );

  /// Local id (the queue's own; the server's is [mediaId]).
  final String id;
  final String sourcePath;
  final String? compressedPath;
  final UploadStatus status;

  /// 0–1 while uploading.
  final double progress;
  final String? mediaId;
  final int attempts;

  /// Bytes after compression.
  final int? byteSize;

  /// Why it failed (an API error code, or `network`).
  final String? errorCode;

  bool get isActive =>
      status == UploadStatus.compressing ||
      status == UploadStatus.uploading ||
      status == UploadStatus.confirming;

  UploadItem copyWith({
    String? compressedPath,
    UploadStatus? status,
    double? progress,
    String? mediaId,
    int? attempts,
    int? byteSize,
    String? errorCode,
    bool clearError = false,
  }) => UploadItem(
    id: id,
    sourcePath: sourcePath,
    compressedPath: compressedPath ?? this.compressedPath,
    status: status ?? this.status,
    progress: progress ?? this.progress,
    mediaId: mediaId ?? this.mediaId,
    attempts: attempts ?? this.attempts,
    byteSize: byteSize ?? this.byteSize,
    errorCode: clearError ? null : (errorCode ?? this.errorCode),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'sourcePath': sourcePath,
    'compressedPath': ?compressedPath,
    'status': status.name,
    'progress': progress,
    'mediaId': ?mediaId,
    'attempts': attempts,
    'byteSize': ?byteSize,
    'errorCode': ?errorCode,
  };
}
