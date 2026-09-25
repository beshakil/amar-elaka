import 'dart:async';
import 'dart:io';

import 'package:amar_elaka_app/features/media_upload/data/image_compressor.dart';
import 'package:amar_elaka_app/features/media_upload/data/media_upload_transport.dart';
import 'package:amar_elaka_app/features/media_upload/data/upload_queue_store.dart';
import 'package:amar_elaka_app/features/media_upload/domain/upload_item.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

/// In-memory stand-ins for the upload queue's collaborators.

class FakeCompressor implements ImageCompressor {
  int calls = 0;
  final Set<String> broken = {};

  @override
  Future<int> compress(String sourcePath, String targetPath) async {
    calls++;
    if (broken.contains(sourcePath)) throw const FileSystemException('corrupt');
    await File(targetPath).writeAsBytes(List.filled(1500, 7));
    return 1500;
  }
}

class FakeTransport implements MediaUploadTransport {
  /// Failures thrown by successive PUTs (null = succeed).
  final List<UploadFailure?> putScript = [];
  final List<String> confirmed = [];
  int presigns = 0;
  int maxConcurrentPuts = 0;
  int _activePuts = 0;
  final Completer<void>? gate;

  FakeTransport({this.gate});

  @override
  Future<PresignedTarget> presign({
    required int byteSize,
    required String sha256,
    required String contentType,
  }) async {
    expect(contentType, 'image/webp');
    expect(sha256, hasLength(64));
    presigns++;
    return PresignedTarget(
      mediaId: 'm$presigns',
      url: 'https://s/$presigns',
      headers: const {},
    );
  }

  @override
  Future<void> put(
    PresignedTarget target,
    File file, {
    required void Function(double progress) onProgress,
    CancelToken? cancelToken,
  }) async {
    _activePuts++;
    if (_activePuts > maxConcurrentPuts) maxConcurrentPuts = _activePuts;
    try {
      await gate?.future;
      await Future<void>.delayed(Duration.zero);
      if (cancelToken?.isCancelled ?? false) {
        throw const UploadFailure('cancelled', retryable: false);
      }
      final failure = putScript.isEmpty ? null : putScript.removeAt(0);
      if (failure != null) throw failure;
      onProgress(0.5);
      onProgress(1);
    } finally {
      _activePuts--;
    }
  }

  @override
  Future<void> confirm(String mediaId) async => confirmed.add(mediaId);
}

class MemoryStore implements UploadQueueStore {
  MemoryStore(this.dir);

  final Directory dir;
  final Map<String, List<UploadItem>> saved = {};

  @override
  Future<List<UploadItem>> load(String queueId) async => saved[queueId] ?? [];

  @override
  Future<void> save(String queueId, List<UploadItem> items) async =>
      saved[queueId] = [...items];

  @override
  Future<String> compressedPathFor(String itemId) async =>
      '${dir.path}/$itemId.webp';

  @override
  Future<void> deleteFile(String? path) async {
    if (path != null && await File(path).exists()) await File(path).delete();
  }
}
