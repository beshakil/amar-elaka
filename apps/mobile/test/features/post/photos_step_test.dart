import 'dart:io';

import 'package:amar_elaka_app/features/media_upload/data/media_upload_transport.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  late Directory dir;
  late List<String> photos;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('photos_step_test');
    photos = [
      for (final name in ['a.jpg', 'b.jpg'])
        (await File(
          '${dir.path}/$name',
        ).writeAsBytes(List.filled(3000, 1))).path,
    ];
  });
  tearDown(() => dir.delete(recursive: true));

  testWidgets(
    'adds several photos, uploads them in the background, then allows going on',
    (tester) async {
      final app = await pumpPostApp(
        tester,
        picker: FakeImagePicker(photos),
        uploadDir: dir,
      );
      await walkTo(tester, PostStep.photos);
      expect(find.text('ধাপ ৩/৬: ছবি'), findsOneWidget);
      expect(
        find.text('প্রথম ছবিটি কভার হিসেবে দেখাবে। চেপে ধরে টেনে ক্রম বদলান।'),
        findsOneWidget,
      );

      await tester.tap(find.byIcon(Icons.add_a_photo_outlined));
      await tester.pumpAndSettle();
      await tester.tap(find.text('গ্যালারি থেকে বেছে নিন'));
      await pumpUntil(tester, () => app.transport.confirmed.length == 2);
      expect(find.text('২/১০'), findsOneWidget); // count in Bengali digits

      await next(tester);
      expect(find.text('ধাপ ৪/৬: অবস্থান'), findsOneWidget);
    },
  );

  testWidgets('says how many failed, in Bengali, and how to fix it', (
    tester,
  ) async {
    final app = await pumpPostApp(
      tester,
      picker: FakeImagePicker(photos.take(1).toList()),
      uploadDir: dir,
    );
    app.transport.putScript.add(
      const UploadFailure('rejected', retryable: false),
    );
    await walkTo(tester, PostStep.photos);
    await tester.tap(find.byIcon(Icons.add_a_photo_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.text('গ্যালারি থেকে বেছে নিন'));
    await pumpUntil(
      tester,
      () => find.textContaining('টি ছবি আপলোড হয়নি').evaluate().isNotEmpty,
    );
    expect(
      find.text(
        '১টি ছবি আপলোড হয়নি — ছবিতে চাপ দিয়ে আবার চেষ্টা করুন অথবা সরিয়ে দিন',
      ),
      findsOneWidget,
    );
  });
}
