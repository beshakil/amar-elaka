import 'dart:convert';
import 'dart:io';

import 'package:drift/drift.dart';

import '../../../core/storage/app_database.dart';
import 'agent_models.dart';

/// A photo as it was captured: the compressed copy on the phone.
class CapturedPhoto {
  const CapturedPhoto({
    required this.localPath,
    required this.byteSize,
    required this.sha256,
  });

  final String localPath;
  final int byteSize;
  final String sha256;
}

/// The queue's states (ADR 066).
abstract final class CaptureState {
  /// Waiting to sync (or to be retried at nextAttemptAt).
  static const queued = 'queued';

  /// A likely duplicate is already on the map: the agent must answer.
  static const needsDecision = 'needs_decision';

  /// On the server (a shop pending review, a verification, an update).
  static const done = 'done';

  /// Refused for good (outside the area, too old…): shown with its reason.
  static const refused = 'refused';
}

/// One capture as the queue screen shows it.
class AgentCapture {
  const AgentCapture({
    required this.id,
    required this.kind,
    required this.title,
    required this.capturedAt,
    required this.state,
    required this.attempts,
    required this.photoPaths,
    required this.candidates,
    required this.fraudFlags,
    this.nextAttemptAt,
    this.errorCode,
    this.errorReason,
    this.placeId,
  });

  final String id;
  final String kind;
  final String title;
  final DateTime capturedAt;
  final String state;
  final int attempts;
  final List<String> photoPaths;
  final List<DuplicateCandidate> candidates;
  final List<String> fraudFlags;
  final DateTime? nextAttemptAt;
  final String? errorCode;
  final String? errorReason;
  final String? placeId;

  bool get waiting => state == CaptureState.queued;
}

/// The agent outbox in Drift: the source of truth for captures until the
/// server has them. Every step of a photo's upload is saved as it finishes.
class AgentCaptureStore {
  AgentCaptureStore(this._db);

  final AppDatabase _db;

  Future<void> add({
    required String id,
    required String tenantId,
    required String kind,
    required String title,
    required Map<String, Object?> payload,
    required DateTime capturedAt,
    required List<CapturedPhoto> photos,
  }) => _db.transaction(() async {
    await _db
        .into(_db.agentCaptures)
        .insert(
          AgentCapturesCompanion.insert(
            id: id,
            tenantId: tenantId,
            kind: kind,
            payloadJson: jsonEncode(payload),
            title: title,
            capturedAt: capturedAt,
          ),
        );
    for (final (i, p) in photos.indexed) {
      await _db
          .into(_db.agentCapturePhotos)
          .insert(
            AgentCapturePhotosCompanion.insert(
              captureId: id,
              position: i,
              localPath: p.localPath,
              byteSize: p.byteSize,
              sha256: p.sha256,
            ),
          );
    }
  });

  Stream<List<AgentCapture>> watch(String tenantId) {
    final query = _db.select(_db.agentCaptures)
      ..where((t) => t.tenantId.equals(tenantId))
      ..orderBy([(t) => OrderingTerm.desc(t.capturedAt)]);
    return query.watch().asyncMap((rows) async {
      final photos = await (_db.select(
        _db.agentCapturePhotos,
      )..orderBy([(t) => OrderingTerm.asc(t.position)])).get();
      return [
        for (final r in rows)
          _toCapture(r, [
            for (final p in photos)
              if (p.captureId == r.id) p.localPath,
          ]),
      ];
    });
  }

  /// Queued captures due now, oldest first (they sync in capture order).
  Future<List<AgentCaptureRow>> due(DateTime now) {
    final query = _db.select(_db.agentCaptures)
      ..where(
        (t) =>
            t.state.equals(CaptureState.queued) &
            (t.nextAttemptAt.isNull() |
                t.nextAttemptAt.isSmallerOrEqualValue(now)),
      )
      ..orderBy([(t) => OrderingTerm.asc(t.capturedAt)]);
    return query.get();
  }

  Future<AgentCaptureRow?> find(String id) => (_db.select(
    _db.agentCaptures,
  )..where((t) => t.id.equals(id))).getSingleOrNull();

  Future<List<AgentCapturePhotoRow>> photos(String captureId) {
    final query = _db.select(_db.agentCapturePhotos)
      ..where((t) => t.captureId.equals(captureId))
      ..orderBy([(t) => OrderingTerm.asc(t.position)]);
    return query.get();
  }

  Future<void> updatePhoto(
    String captureId,
    int position, {
    required String stage,
    String? mediaId,
    String? url,
    Map<String, String>? headers,
  }) =>
      (_db.update(_db.agentCapturePhotos)..where(
            (t) => t.captureId.equals(captureId) & t.position.equals(position),
          ))
          .write(
            AgentCapturePhotosCompanion(
              stage: Value(stage),
              mediaId: Value(mediaId),
              uploadUrl: Value(url),
              uploadHeadersJson: Value(
                headers == null ? null : jsonEncode(headers),
              ),
            ),
          );

  Future<void> markDone(
    String id,
    SubmissionResult result,
    DateTime now,
  ) async {
    await _write(
      id,
      AgentCapturesCompanion(
        state: const Value(CaptureState.done),
        placeId: Value(result.placeId),
        fraudFlagsJson: Value(jsonEncode(result.fraudFlags)),
        candidatesJson: const Value(null),
        errorCode: const Value(null),
        errorReason: const Value(null),
        syncedAt: Value(now),
      ),
    );
    // The photos are on the server now: free the phone's copies.
    for (final p in await photos(id)) {
      await _deleteFile(p.localPath);
    }
  }

  Future<void> markNeedsDecision(
    String id,
    List<DuplicateCandidate> candidates,
  ) => _write(
    id,
    AgentCapturesCompanion(
      state: const Value(CaptureState.needsDecision),
      candidatesJson: Value(
        jsonEncode([for (final c in candidates) c.toJson()]),
      ),
      errorCode: const Value(null),
    ),
  );

  Future<void> markRefused(String id, String code, String? reason) => _write(
    id,
    AgentCapturesCompanion(
      state: const Value(CaptureState.refused),
      errorCode: Value(code),
      errorReason: Value(reason),
    ),
  );

  Future<void> markRetry(String id, int attempts, DateTime next, String code) =>
      _write(
        id,
        AgentCapturesCompanion(
          attempts: Value(attempts),
          nextAttemptAt: Value(next),
          errorCode: Value(code),
        ),
      );

  /// The agent's answer to "already on the map?": queued again with it.
  Future<void> decide(String id, Map<String, Object?> decision) => _write(
    id,
    AgentCapturesCompanion(
      state: const Value(CaptureState.queued),
      decisionJson: Value(jsonEncode(decision)),
      nextAttemptAt: const Value(null),
      attempts: const Value(0),
    ),
  );

  /// Try a refused or waiting capture again now.
  Future<void> retryNow(String id) => _write(
    id,
    const AgentCapturesCompanion(
      state: Value(CaptureState.queued),
      nextAttemptAt: Value(null),
      errorCode: Value(null),
      errorReason: Value(null),
    ),
  );

  Future<void> discard(String id) async {
    for (final p in await photos(id)) {
      await _deleteFile(p.localPath);
    }
    await (_db.delete(
      _db.agentCapturePhotos,
    )..where((t) => t.captureId.equals(id))).go();
    await (_db.delete(_db.agentCaptures)..where((t) => t.id.equals(id))).go();
  }

  Future<void> _write(String id, AgentCapturesCompanion values) => (_db.update(
    _db.agentCaptures,
  )..where((t) => t.id.equals(id))).write(values);

  Future<void> _deleteFile(String path) async {
    try {
      final file = File(path);
      if (file.existsSync()) await file.delete();
    } on FileSystemException {
      // Already gone: nothing to free.
    }
  }

  static AgentCapture _toCapture(
    AgentCaptureRow r,
    List<String> photos,
  ) => AgentCapture(
    id: r.id,
    kind: r.kind,
    title: r.title,
    capturedAt: r.capturedAt,
    state: r.state,
    attempts: r.attempts,
    photoPaths: photos,
    candidates: r.candidatesJson == null
        ? const []
        : [
            for (final c in jsonDecode(r.candidatesJson!) as List)
              DuplicateCandidate.fromJson(c as Map<String, dynamic>),
          ],
    fraudFlags: r.fraudFlagsJson == null
        ? const []
        : [for (final f in jsonDecode(r.fraudFlagsJson!) as List) f as String],
    nextAttemptAt: r.nextAttemptAt,
    errorCode: r.errorCode,
    errorReason: r.errorReason,
    placeId: r.placeId,
  );
}
