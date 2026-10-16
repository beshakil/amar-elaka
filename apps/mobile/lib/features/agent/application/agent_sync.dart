import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import '../../../core/network/api_exception.dart';
import '../../media_upload/data/media_upload_transport.dart';
import '../data/agent_api.dart';
import '../data/agent_capture_store.dart';

/// How a capture's sync attempt ended.
enum SyncOutcome { done, needsDecision, refused, retryLater }

/// Sends the agent's queued captures (ADR 066), one at a time, oldest first:
///
///  1. each photo: presign → PUT → confirm (ready). Every finished step is
///     saved, so a sync cut off mid-way resumes where it stopped — an
///     uploaded photo is never sent again; an interrupted PUT starts that
///     photo over with a fresh URL (they are ~150 KB after compression);
///  2. the submission, with the phone's UUID as its id: the server makes the
///     shop once whatever happens, so a lost answer is simply sent again;
///  3. the answer: done | "already on the map?" (the agent decides, then it is
///     queued again with the answer) | refused (with the server's reason);
///  4. no network, a timeout, 5xx or 429: retried with backoff; the queue
///     stops at the first network failure (the next ones would fail too).
/// One sync runs at a time; asking while one runs joins it.
class AgentSync {
  AgentSync({
    required this._store,
    required this._api,
    required this._transport,
    DateTime Function()? clock,
  }) : _clock = clock ?? DateTime.now;

  final AgentCaptureStore _store;
  final AgentApi _api;
  final MediaUploadTransport _transport;
  final DateTime Function() _clock;

  /// Backoff bounds: transport tuning for a phone's retries, not a business rule.
  static const _firstRetry = Duration(seconds: 15);
  static const _maxRetry = Duration(minutes: 30);
  static const _contentType = 'image/webp';

  Future<void>? _running;

  /// Syncs everything due. Concurrent calls share one run.
  Future<void> syncAll() =>
      _running ??= _run().whenComplete(() => _running = null);

  Future<void> _run() async {
    for (final row in await _store.due(_clock())) {
      final outcome = await syncOne(row.id);
      if (outcome == SyncOutcome.retryLater) break;
    }
  }

  Future<SyncOutcome> syncOne(String id) async {
    final row = await _store.find(id);
    if (row == null || row.state != CaptureState.queued) {
      return SyncOutcome.done;
    }
    try {
      final mediaIds = await _uploadPhotos(id);
      final payload = jsonDecode(row.payloadJson) as Map<String, dynamic>;
      final result = await _api.submit({
        ...payload,
        'id': id,
        'photoIds': mediaIds,
        if (row.decisionJson != null)
          'duplicateDecision': jsonDecode(row.decisionJson!),
      });
      if (result.status == 'needs_decision') {
        await _store.markNeedsDecision(id, result.candidates);
        return SyncOutcome.needsDecision;
      }
      await _store.markDone(id, result, _clock());
      return SyncOutcome.done;
    } on UploadFailure catch (failure) {
      if (failure.retryable) return _retry(row.id, row.attempts, failure.code);
      await _store.markRefused(id, 'MEDIA_REFUSED', failure.code);
      return SyncOutcome.refused;
    } on ApiException catch (e) {
      if (_retryable(e.statusCode)) return _retry(row.id, row.attempts, e.code);
      final details = e.body.details;
      final reason = details is Map ? details['reason'] as String? : null;
      await _store.markRefused(id, e.code, reason);
      return SyncOutcome.refused;
    } on AppException {
      return _retry(row.id, row.attempts, 'network');
    } on FileSystemException {
      // The photo's copy is gone from the phone: nothing to send.
      await _store.markRefused(id, 'PHOTO_MISSING', null);
      return SyncOutcome.refused;
    }
  }

  /// Uploads the photos not yet ready; returns every photo's media id in order.
  Future<List<String>> _uploadPhotos(String captureId) async {
    final ids = <String>[];
    for (final photo in await _store.photos(captureId)) {
      var stage = photo.stage;
      var mediaId = photo.mediaId;
      var url = photo.uploadUrl;
      var headers = photo.uploadHeadersJson == null
          ? const <String, String>{}
          : Map<String, String>.from(
              jsonDecode(photo.uploadHeadersJson!) as Map,
            );

      if (stage == 'none') {
        final target = await _transport.presign(
          byteSize: photo.byteSize,
          sha256: photo.sha256,
          contentType: _contentType,
        );
        (mediaId, url, headers, stage) = (
          target.mediaId,
          target.url,
          target.headers,
          'presigned',
        );
        await _store.updatePhoto(
          captureId,
          photo.position,
          stage: stage,
          mediaId: mediaId,
          url: url,
          headers: headers,
        );
      }
      if (stage == 'presigned') {
        try {
          await _transport.put(
            PresignedTarget(mediaId: mediaId!, url: url!, headers: headers),
            File(photo.localPath),
            onProgress: (_) {},
          );
        } on UploadFailure {
          // The URL may have expired: this photo starts over next time.
          await _store.updatePhoto(captureId, photo.position, stage: 'none');
          rethrow;
        }
        stage = 'uploaded';
        await _store.updatePhoto(
          captureId,
          photo.position,
          stage: stage,
          mediaId: mediaId,
        );
      }
      if (stage == 'uploaded') {
        await _transport.confirm(mediaId!);
        stage = 'ready';
        await _store.updatePhoto(
          captureId,
          photo.position,
          stage: stage,
          mediaId: mediaId,
        );
      }
      ids.add(mediaId!);
    }
    return ids;
  }

  Future<SyncOutcome> _retry(String id, int attempts, String code) async {
    final next = attempts + 1;
    final wait = Duration(
      milliseconds: math.min(
        _firstRetry.inMilliseconds * math.pow(2, attempts).toInt(),
        _maxRetry.inMilliseconds,
      ),
    );
    await _store.markRetry(id, next, _clock().add(wait), code);
    return SyncOutcome.retryLater;
  }

  // 401: the session lapsed (the client refreshes it); the capture waits, it is not refused.
  static bool _retryable(int status) =>
      status >= 500 || status == 408 || status == 429 || status == 401;
}
