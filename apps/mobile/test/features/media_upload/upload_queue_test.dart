import 'dart:async';
import 'dart:io';

import 'package:amar_elaka_app/features/media_upload/application/upload_queue.dart';
import 'package:amar_elaka_app/features/media_upload/data/image_compressor.dart';
import 'package:amar_elaka_app/features/media_upload/data/media_upload_transport.dart';
import 'package:amar_elaka_app/features/media_upload/domain/upload_item.dart';
import 'package:flutter_test/flutter_test.dart';

import 'upload_fakes.dart';

void main() {
  late Directory dir;
  late FakeCompressor compressor;
  late MemoryStore store;
  final delays = <Duration>[];
  var ids = 0;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('upload_queue_test');
    compressor = FakeCompressor();
    store = MemoryStore(dir);
    delays.clear();
    ids = 0;
  });
  tearDown(() => dir.delete(recursive: true));

  UploadQueue queueWith(FakeTransport transport) => UploadQueue(
    queueId: 'q',
    compressor: compressor,
    transport: transport,
    store: store,
    delay: (d) async => delays.add(d),
    newId: () => 'item${++ids}',
  );

  /// Waits (in real time: the queue does file I/O) until nothing is in flight.
  Future<void> settle(UploadQueue queue) async {
    bool busy() => queue.items.any(
      (i) => i.status != UploadStatus.done && i.status != UploadStatus.failed,
    );
    for (var i = 0; i < 400 && busy(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 5));
    }
  }

  test(
    'compresses, uploads and confirms every photo, two at a time, in order',
    () async {
      final transport = FakeTransport();
      final queue = queueWith(transport);
      await queue.add(['a.jpg', 'b.jpg', 'c.jpg']);
      await settle(queue);

      expect(queue.items.map((i) => i.status), everyElement(UploadStatus.done));
      expect(queue.mediaIds, hasLength(3));
      expect(queue.isComplete, isTrue);
      expect(transport.maxConcurrentPuts, lessThanOrEqualTo(2));
      expect(compressor.calls, 3);
      expect(
        store.saved['q']!.every((i) => i.status == UploadStatus.done),
        isTrue,
      );
      expect(queue.items.first.byteSize, 1500);
    },
  );

  test('retries a network failure with backoff, then succeeds', () async {
    final transport = FakeTransport()
      ..putScript.addAll([const UploadFailure('network', retryable: true)]);
    final queue = queueWith(transport);
    await queue.add(['a.jpg']);
    await settle(queue);

    expect(queue.items.single.status, UploadStatus.done);
    expect(queue.items.single.attempts, 1);
    expect(delays, [UploadQueue.defaultRetryDelays.first]);
    expect(
      compressor.calls,
      1,
      reason: 'the compressed file is reused on retry',
    );
  });

  test('gives up after the last retry and can be retried by hand', () async {
    final transport = FakeTransport()
      ..putScript.addAll(
        List.filled(4, const UploadFailure('network', retryable: true)),
      );
    final queue = queueWith(transport);
    await queue.add(['a.jpg']);
    await settle(queue);

    expect(queue.items.single.status, UploadStatus.failed);
    expect(queue.items.single.errorCode, 'network');
    expect(delays, UploadQueue.defaultRetryDelays);

    await queue.retry('item1');
    await settle(queue);
    expect(queue.items.single.status, UploadStatus.done);
  });

  test('fails at once when the server refuses the file', () async {
    final transport = FakeTransport()
      ..putScript.add(const UploadFailure('UPLOAD_REJECTED', retryable: false));
    final queue = queueWith(transport);
    await queue.add(['a.jpg']);
    await settle(queue);

    expect(queue.items.single.status, UploadStatus.failed);
    expect(queue.items.single.errorCode, 'UPLOAD_REJECTED');
    expect(delays, isEmpty);
  });

  test('marks a photo that cannot be compressed as failed', () async {
    compressor.broken.add('broken.jpg');
    final queue = queueWith(FakeTransport());
    await queue.add(['broken.jpg', 'ok.jpg']);
    await settle(queue);
    expect(queue.items.map((i) => i.status), [
      UploadStatus.failed,
      UploadStatus.done,
    ]);
    expect(queue.items.first.errorCode, 'compression');
  });

  test('resumes after an app restart without compressing again', () async {
    final compressed = '${dir.path}/saved.webp';
    await File(compressed).writeAsBytes(List.filled(900, 1));
    store.saved['q'] = [
      const UploadItem(
        id: 'done',
        sourcePath: 'x.jpg',
        status: UploadStatus.done,
        mediaId: 'm-old',
      ),
      UploadItem(
        id: 'half',
        sourcePath: 'y.jpg',
        compressedPath: compressed,
        status: UploadStatus.uploading,
        progress: 0.6,
      ),
    ];
    final transport = FakeTransport();
    final queue = queueWith(transport);
    await queue.restore();
    await settle(queue);

    expect(queue.items.map((i) => i.status), [
      UploadStatus.done,
      UploadStatus.done,
    ]);
    expect(queue.mediaIds, ['m-old', 'm1']);
    expect(compressor.calls, 0);
    expect(transport.presigns, 1);
  });

  test('takes at most 10 photos', () async {
    final gate = Completer<void>();
    final queue = queueWith(FakeTransport(gate: gate));
    expect(await queue.add(List.generate(12, (i) => '$i.jpg')), 10);
    expect(queue.remainingSlots, 0);
    expect(await queue.add(['more.jpg']), 0);
    gate.complete();
    await settle(queue);
  });

  test('reorders and removes, cancelling an upload in flight', () async {
    final gate = Completer<void>();
    final transport = FakeTransport(gate: gate);
    final queue = queueWith(transport);
    await queue.add(['a.jpg', 'b.jpg', 'c.jpg']);
    await Future<void>.delayed(Duration.zero);

    await queue.reorder(2, 0); // c first
    await queue.reorder(1, 2); // a last
    await queue.reorder(2, 1); // a back
    expect(queue.items.map((i) => i.sourcePath), ['c.jpg', 'a.jpg', 'b.jpg']);
    expect(store.saved['q']!.map((i) => i.sourcePath), [
      'c.jpg',
      'a.jpg',
      'b.jpg',
    ]);

    final removed = queue.items.firstWhere((i) => i.sourcePath == 'a.jpg');
    await queue.remove(removed.id);
    gate.complete();
    await settle(queue);

    expect(queue.items.map((i) => i.sourcePath), ['c.jpg', 'b.jpg']);
    expect(queue.items.map((i) => i.status), everyElement(UploadStatus.done));
    expect(transport.confirmed, hasLength(2));
    expect(File('${dir.path}/${removed.id}.webp').existsSync(), isFalse);
  });

  group('compressionBound', () {
    test('gives a long edge of 1200 whatever the orientation', () {
      // flutter_image_compress scales by min(w / bound, h / bound).
      int longEdgeAfter(int w, int h) {
        final bound = compressionBound(w, h);
        final scale = [w / bound, h / bound].reduce((a, b) => a < b ? a : b);
        final factor = scale < 1 ? 1 : scale;
        return ((w > h ? w : h) / factor).round();
      }

      // The bound is floored, so the long edge may land a pixel or two short.
      final nearMax = inInclusiveRange(1195, 1200);
      expect(longEdgeAfter(4000, 3000), 1200);
      expect(longEdgeAfter(3000, 4000), 1200);
      expect(longEdgeAfter(4032, 1908), nearMax);
      expect(longEdgeAfter(1908, 4032), nearMax);
    });

    test('never enlarges a small photo', () {
      expect(compressionBound(800, 600), 600);
      expect(compressionBound(1200, 900), 900);
    });
  });
}
