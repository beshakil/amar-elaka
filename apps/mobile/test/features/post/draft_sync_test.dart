import 'dart:async';
import 'dart:io';

import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/network/connectivity_provider.dart';
import 'package:amar_elaka_app/core/storage/app_database_provider.dart';
import 'package:amar_elaka_app/features/media_upload/application/upload_queue.dart';
import 'package:amar_elaka_app/features/post/application/draft_sync.dart';
import 'package:amar_elaka_app/features/post/data/post_draft_store.dart';
import 'package:amar_elaka_app/features/post/data/posts_api.dart';
import 'package:amar_elaka_app/features/post/domain/post_draft.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../media_upload/upload_fakes.dart';
import 'post_test_harness.dart';

void main() {
  late Directory dir;
  setUp(
    () async => dir = await Directory.systemTemp.createTemp('draft_sync_test'),
  );
  tearDown(() => dir.delete(recursive: true));

  ProviderContainer container(
    FakePostsApi api, {
    required Stream<bool> online,
  }) {
    final db = memoryDatabase();
    final c = ProviderContainer(
      overrides: [
        postsApiProvider.overrideWithValue(api),
        appDatabaseProvider.overrideWithValue(db),
        isOnlineProvider.overrideWith((ref) => online),
        uploadQueueProvider.overrideWith((ref, id) {
          final q = UploadQueue(
            queueId: id,
            compressor: FakeCompressor(),
            transport: FakeTransport(),
            store: MemoryStore(dir),
          );
          ref.onDispose(q.dispose);
          q.restore();
          return q;
        }),
      ],
    );
    addTearDown(() async {
      c.dispose();
      await db.close();
    });
    return c;
  }

  Future<PostDraft> queuedDraft(ProviderContainer c) async {
    final store = c.read(postDraftStoreProvider);
    final draft = await store.createNew(
      contactName: 'রহিম',
      contactPhone: '+8801712345678',
    );
    final ready = draft.copyWith(
      step: PostStep.preview,
      category: phoneCategory,
      title: 'আইফোন',
      formState: {'condition': 'used', 'price': '৬৫০০০'},
      lat: 23.8,
      lng: 90.4,
      submitState: DraftSubmitState.queued,
    );
    await store.save(ready);
    return ready;
  }

  test(
    'sends queued drafts with their own Idempotency-Key once online, then forgets them',
    () async {
      final api = FakePostsApi();
      final c = container(api, online: Stream.value(true));
      final draft = await queuedDraft(c);

      await c.read(draftSyncProvider).sendQueued();

      expect(api.created.single.key, draft.idempotencyKey);
      expect(await c.read(postDraftStoreProvider).queued(), isEmpty);
    },
  );

  test('still offline: keeps it queued and stops', () async {
    final api = FakePostsApi()..createErrors.add(apiError('X'));
    final c = container(api, online: Stream.value(true));
    await queuedDraft(c);
    api.createErrors
      ..clear()
      ..add(const NetworkException());

    await c.read(draftSyncProvider).sendQueued();

    expect(api.created, isEmpty);
    expect(await c.read(postDraftStoreProvider).queued(), hasLength(1));
  });

  test('starts by itself when the connection comes back', () async {
    final api = FakePostsApi();
    final online = StreamController<bool>();
    final c = container(api, online: online.stream);
    await queuedDraft(c);
    // As the Post tab does: watched, so it stays active.
    c.listen(draftSyncProvider, (_, _) {});

    online.add(false);
    await pumpEventQueue();
    expect(api.created, isEmpty);

    online.add(true);
    await pumpEventQueue(times: 50);
    expect(api.created, hasLength(1));
    await online.close();
  });
}
