import 'dart:io';

import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/features/media_upload/application/upload_queue.dart';
import 'package:amar_elaka_app/features/media_upload/domain/upload_item.dart';
import 'package:amar_elaka_app/features/media_upload/presentation/media_picker_field.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'upload_fakes.dart';

void main() {
  late Directory dir;
  late MemoryStore store;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('media_picker_test');
    store = MemoryStore(dir)
      ..saved['q'] = const [
        UploadItem(
          id: 'a',
          sourcePath: 'a.jpg',
          status: UploadStatus.done,
          mediaId: 'm-a',
        ),
        UploadItem(
          id: 'b',
          sourcePath: 'b.jpg',
          status: UploadStatus.failed,
          errorCode: 'network',
        ),
      ];
  });
  tearDown(() => dir.delete(recursive: true));

  Future<UploadQueue> pump(WidgetTester tester) async {
    final queue = UploadQueue(
      queueId: 'q',
      compressor: FakeCompressor(),
      transport: FakeTransport(),
      store: store,
    );
    addTearDown(queue.dispose);
    await tester.runAsync(queue.restore);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: MediaPickerField(queue: queue)),
      ),
    );
    return queue;
  }

  testWidgets('shows the count in Bengali digits and labels the cover', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    await pump(tester);

    expect(find.text('২/১০'), findsOneWidget);
    expect(
      find.bySemanticsLabel(RegExp('ছবি ১, প্রচ্ছদ, আপলোড সম্পন্ন')),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel(RegExp('ছবি ২, আপলোড হয়নি')), findsOneWidget);
    expect(find.byTooltip('আবার চেষ্টা করুন'), findsOneWidget);
    handle.dispose();
  });

  testWidgets('removes a photo', (tester) async {
    final queue = await pump(tester);
    await tester.runAsync(() async {
      await tester.tap(find.byTooltip('ছবিটি সরান').last);
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });
    await tester.pump();

    expect(queue.items.map((i) => i.id), ['a']);
    expect(find.text('১/১০'), findsOneWidget);
  });

  testWidgets('retries a failed photo', (tester) async {
    final queue = await pump(tester);
    await tester.runAsync(() async {
      await tester.tap(find.byTooltip('আবার চেষ্টা করুন'));
      for (var i = 0; i < 100 && !queue.isComplete; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
    });
    await tester.pump();

    expect(queue.mediaIds, ['m-a', 'm1']);
    expect(find.byTooltip('আবার চেষ্টা করুন'), findsNothing);
  });
}
