import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import '../test/features/feed/feed_test_harness.dart';

/// Scrolls 200 feed items (10 pages of 20) and records the frame timeline
/// (ADR 038). Photos are real encoded images decoded at card size, so the
/// decode cost of a real feed is in the numbers. Run in profile mode on the
/// 2 GB phone via test_driver/perf_driver.dart.
void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('scroll 200 feed items', (tester) async {
    const pages = 10;
    const perPage = 20;
    final feed = FakeFeedApi();
    String page(int n) => feedPageJson([
      for (var i = 0; i < perPage; i++)
        postCardJson(
          postCard(
            id: 'p${n * perPage + i}',
            title: 'পোস্ট নম্বর ${n * perPage + i} — ব্যবহৃত স্মার্টফোন বিক্রি',
            badges: i % 5 == 0 ? const ['boosted'] : const [],
          ),
        ),
    ], nextCursor: n + 1 < pages ? 'c${n + 1}' : null);
    feed.firstPage = page(0);
    for (var n = 1; n < pages; n++) {
      feed.pagesAfter['c$n'] = page(n);
    }

    // One 600×450 photo, encoded as PNG like a card variant would arrive.
    final photo = await tester.runAsync(_encodedPhoto);
    await pumpFeedApp(
      tester,
      feed: feed,
      photos: (url, placeholder) => Image(
        image: ResizeImage(
          MemoryImage(photo!),
          width: (112 * tester.view.devicePixelRatio).round(),
        ),
        fit: BoxFit.cover,
        frameBuilder: (context, child, frame, _) =>
            frame == null ? placeholder : child,
      ),
    );

    final list = find.byWidgetPredicate(
      (w) => w is Scrollable && w.axisDirection == AxisDirection.down,
    );
    await binding.traceAction(() async {
      for (var i = 0; i < 60; i++) {
        await tester.fling(list, const Offset(0, -900), 2500);
        await tester.pumpAndSettle();
      }
    }, reportKey: 'feed_scroll');

    expect(feed.requests.length, pages);
  });
}

Future<Uint8List> _encodedPhoto() async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  const size = Size(600, 450);
  canvas.drawRect(
    Offset.zero & size,
    Paint()
      ..shader = const LinearGradient(
        colors: [Color(0xFFE8703A), Color(0xFF3A7BE8)],
      ).createShader(Offset.zero & size),
  );
  final image = await recorder.endRecording().toImage(600, 450);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return bytes!.buffer.asUint8List();
}
