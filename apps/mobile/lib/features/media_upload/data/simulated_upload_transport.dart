import 'dart:io';

import 'package:dio/dio.dart';

import 'media_upload_transport.dart';

/// A stand-in for the media API, for the debug preview only: uploads take a
/// realistic moment with visible progress, and every third upload's first
/// attempt fails with a network error so retry can be seen working. Nothing
/// leaves the phone.
class SimulatedUploadTransport implements MediaUploadTransport {
  SimulatedUploadTransport({this.step = const Duration(milliseconds: 120)});

  final Duration step;
  int _presigned = 0;
  final Set<String> _failedOnce = {};

  @override
  Future<PresignedTarget> presign({
    required int byteSize,
    required String sha256,
    required String contentType,
  }) async {
    await Future<void>.delayed(step);
    _presigned++;
    return PresignedTarget(
      mediaId: 'simulated-$_presigned-${sha256.substring(0, 8)}',
      url: 'simulated://upload/$_presigned',
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
    const ticks = 10;
    for (var tick = 1; tick <= ticks; tick++) {
      await Future<void>.delayed(step);
      if (cancelToken?.isCancelled ?? false) {
        throw const UploadFailure('cancelled', retryable: false);
      }
      final flaky =
          target.mediaId.startsWith('simulated-3-') ||
          target.mediaId.startsWith('simulated-6-');
      if (flaky && tick == ticks ~/ 2 && _failedOnce.add(target.mediaId)) {
        throw const UploadFailure('network', retryable: true);
      }
      onProgress(tick / ticks);
    }
  }

  @override
  Future<void> confirm(String mediaId) => Future<void>.delayed(step);
}
