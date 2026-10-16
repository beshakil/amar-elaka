import 'dart:convert';
import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart' show ApiErrorBody;
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/features/agent/application/agent_sync.dart';
import 'package:amar_elaka_app/features/agent/data/agent_api.dart';
import 'package:amar_elaka_app/features/agent/data/agent_capture_store.dart';
import 'package:amar_elaka_app/features/agent/data/agent_models.dart';
import 'package:amar_elaka_app/features/agent/domain/capture_rules.dart';
import 'package:amar_elaka_app/features/media_upload/data/media_upload_transport.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

/// Field agent mode's offline sync (ADR 066): captures queued with no
/// network sync later into exactly one shop each, however often the sync
/// runs; photos resume from the last finished step; "already on the map?"
/// waits for the agent's answer; refusals keep the server's reason.

AppDatabase _memoryDb() => AppDatabase.forTesting(
  DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true),
);

/// The server's promise, modelled: one shop per submission id, whatever happens.
class FakeAgentServer implements AgentApi {
  final shops = <String, String>{};
  final bodies = <Map<String, Object?>>[];
  int submitCalls = 0;

  /// The next submit: fail with no network before (or after!) the server acts.
  bool dropNextBeforeServer = false;
  bool dropNextAfterServer = false;
  List<DuplicateCandidate> duplicates = const [];
  ApiException? refuseNext;

  @override
  Future<SubmissionResult> submit(Map<String, Object?> body) async {
    submitCalls++;
    bodies.add(body);
    if (dropNextBeforeServer) {
      dropNextBeforeServer = false;
      throw const NetworkException();
    }
    if (refuseNext != null) {
      final e = refuseNext!;
      refuseNext = null;
      throw e;
    }
    final id = body['id']! as String;
    if (duplicates.isNotEmpty &&
        body['duplicateDecision'] == null &&
        !shops.containsKey(id)) {
      return SubmissionResult(
        id: id,
        status: 'needs_decision',
        fraudFlags: const [],
        candidates: duplicates,
      );
    }
    final placeId = shops.putIfAbsent(id, () => 'place-${shops.length + 1}');
    if (dropNextAfterServer) {
      dropNextAfterServer = false;
      // The shop exists now, but the answer never reaches the phone.
      throw const NetworkException();
    }
    return SubmissionResult(
      id: id,
      status: 'created',
      placeId: placeId,
      fraudFlags: const [],
      candidates: const [],
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class FlakyTransport implements MediaUploadTransport {
  int presigns = 0;
  int puts = 0;
  int confirms = 0;
  int failPuts = 0;
  int failConfirms = 0;

  @override
  Future<PresignedTarget> presign({
    required int byteSize,
    required String sha256,
    required String contentType,
  }) async {
    presigns++;
    return PresignedTarget(
      mediaId: 'media-$presigns',
      url: 'https://storage/put/$presigns',
      headers: const {},
    );
  }

  @override
  Future<void> put(
    PresignedTarget target,
    File file, {
    required void Function(double) onProgress,
    CancelToken? cancelToken,
  }) async {
    puts++;
    if (failPuts > 0) {
      failPuts--;
      throw const UploadFailure('network', retryable: true);
    }
  }

  @override
  Future<void> confirm(String mediaId) async {
    confirms++;
    if (failConfirms > 0) {
      failConfirms--;
      throw const UploadFailure('processing_timeout', retryable: true);
    }
  }
}

void main() {
  late AppDatabase db;
  late AgentCaptureStore store;
  late FakeAgentServer server;
  late FlakyTransport transport;
  late AgentSync sync;
  late Directory tmp;
  var now = DateTime.utc(2026, 10, 16, 5);

  setUp(() async {
    db = _memoryDb();
    store = AgentCaptureStore(db);
    server = FakeAgentServer();
    transport = FlakyTransport();
    now = DateTime.utc(2026, 10, 16, 5);
    sync = AgentSync(
      store: store,
      api: server,
      transport: transport,
      clock: () => now,
    );
    tmp = await Directory.systemTemp.createTemp('agent_sync_test');
  });

  tearDown(() async {
    await db.close();
    await tmp.delete(recursive: true);
  });

  /// A capture saved with no network: queued with its photo on the phone.
  Future<String> capture(String id, {int photos = 1}) async {
    final kept = <CapturedPhoto>[];
    for (var i = 0; i < photos; i++) {
      final file = File('${tmp.path}/$id-$i.webp')
        ..writeAsBytesSync([1, 2, 3, i]);
      kept.add(
        CapturedPhoto(localPath: file.path, byteSize: 4, sha256: '$i' * 64),
      );
    }
    await store.add(
      id: id,
      tenantId: 't1',
      kind: 'new_shop',
      title: 'করিম স্টোর',
      payload: {
        'kind': 'new_shop',
        'capturedAt': now.toIso8601String(),
        'location': {'lat': 23.8, 'lng': 90.4},
        'accuracyM': 6.0,
        'nameBn': 'করিম স্টোর',
        'categoryId': 'cat-1',
      },
      capturedAt: now,
      photos: kept,
    );
    return id;
  }

  Future<AgentCaptureRow> row(String id) async => (await store.find(id))!;

  test(
    'a capture made offline syncs into exactly one shop, even when the sync runs twice',
    () async {
      final id = await capture('11111111-1111-4111-8111-111111111111');
      // No network yet: nothing is lost, it waits.
      server.dropNextBeforeServer = true;
      await sync.syncAll();
      expect((await row(id)).state, CaptureState.queued);
      expect((await row(id)).errorCode, 'network');

      // Back online: two syncs at once share one run.
      now = now.add(const Duration(hours: 1));
      await Future.wait([sync.syncAll(), sync.syncAll()]);
      expect((await row(id)).state, CaptureState.done);
      expect(server.shops, hasLength(1));
      expect(server.submitCalls, 2);

      // Syncing again sends nothing more.
      await sync.syncAll();
      expect(server.submitCalls, 2);
      expect(server.shops, hasLength(1));
    },
  );

  test(
    'a lost answer is sent again with the same id, and the server makes nothing new',
    () async {
      final id = await capture('22222222-2222-4222-8222-222222222222');
      server.dropNextAfterServer = true;
      await sync.syncAll();
      expect((await row(id)).state, CaptureState.queued);
      now = now.add(const Duration(hours: 1));
      await sync.syncAll();
      expect((await row(id)).state, CaptureState.done);
      expect(server.bodies.map((b) => b['id']).toSet(), {id});
      expect(server.shops, hasLength(1));
      expect((await row(id)).placeId, server.shops[id]);
    },
  );

  test('photos resume from the last finished step', () async {
    final id = await capture('33333333-3333-4333-8333-333333333333', photos: 2);
    // The first PUT fails: that photo starts over (a fresh URL) next time.
    transport.failPuts = 1;
    await sync.syncAll();
    expect((await store.photos(id)).first.stage, 'none');
    now = now.add(const Duration(hours: 1));
    // Uploaded, then the confirm times out: next time only the confirm runs.
    transport.failConfirms = 1;
    await sync.syncAll();
    expect((await store.photos(id)).first.stage, 'uploaded');
    final putsBefore = transport.puts;
    now = now.add(const Duration(hours: 1));
    await sync.syncAll();
    final photos = await store.photos(id);
    expect(photos.map((p) => p.stage), ['ready', 'ready']);
    // The first photo was not uploaded again; only the second photo's PUT ran.
    expect(transport.puts - putsBefore, 1);
    expect(server.bodies.last['photoIds'], [
      photos[0].mediaId,
      photos[1].mediaId,
    ]);
    // Synced: the phone's copies are freed.
    expect(File(photos.first.localPath).existsSync(), isFalse);
  });

  test(
    'a shop already on the map waits for the agent, then follows the answer',
    () async {
      final id = await capture('44444444-4444-4444-8444-444444444444');
      server.duplicates = const [
        DuplicateCandidate(
          placeId: 'place-old',
          nameBn: 'করিম স্টোর',
          distanceM: 12,
          phoneMatch: false,
        ),
      ];
      await sync.syncAll();
      expect((await row(id)).state, CaptureState.needsDecision);
      expect(server.shops, isEmpty);

      await store.decide(id, {'decision': 'same', 'placeId': 'place-old'});
      await sync.syncAll();
      expect((await row(id)).state, CaptureState.done);
      expect(server.bodies.last['duplicateDecision'], {
        'decision': 'same',
        'placeId': 'place-old',
      });
    },
  );

  test(
    'a refusal keeps the server reason; a retry waits with backoff',
    () async {
      final id = await capture('55555555-5555-4555-8555-555555555555');
      server.refuseNext = ApiException(
        const ApiErrorBody(
          statusCode: 422,
          error: 'AGENT_SUBMISSION_REFUSED',
          message: 'refused',
          details: {'reason': 'outside_area'},
        ),
      );
      await sync.syncAll();
      final refused = await row(id);
      expect(refused.state, CaptureState.refused);
      expect(
        (refused.errorCode, refused.errorReason),
        ('AGENT_SUBMISSION_REFUSED', 'outside_area'),
      );

      final other = await capture('66666666-6666-4666-8666-666666666666');
      server.refuseNext = ApiException(
        const ApiErrorBody(
          statusCode: 503,
          error: 'SERVICE_UNAVAILABLE',
          message: 'later',
        ),
      );
      await sync.syncAll();
      final waiting = await row(other);
      expect(waiting.state, CaptureState.queued);
      expect(waiting.nextAttemptAt!.isAfter(now), isTrue);
      // Not due yet: nothing is sent.
      final calls = server.submitCalls;
      await sync.syncAll();
      expect(server.submitCalls, calls);
      expect(
        jsonDecode((await row(id)).payloadJson),
        isA<Map<String, dynamic>>(),
      );
    },
  );

  group('capture rules', () {
    test('a fix worse than agent_min_gps_accuracy_m cannot be saved', () {
      expect(accurateEnough(null, 25), isFalse);
      expect(accurateEnough(40, 25), isFalse);
      expect(accurateEnough(25, 25), isTrue);
      expect(fixQuality(40, 25), FixQuality.poor);
      expect(fixQuality(20, 25), FixQuality.fair);
      expect(fixQuality(8, 25), FixQuality.good);
    });

    test('an hours preset is the API business hours', () {
      final friOff = hoursPresets.firstWhere((p) => p.key == 'fri_off_10_20');
      final hours = friOff.toBusinessHours();
      expect(hours.map((h) => h['day']), isNot(contains(5)));
      expect(hours.first, {'day': 1, 'opens': '10:00', 'closes': '20:00'});
    });
  });
}
