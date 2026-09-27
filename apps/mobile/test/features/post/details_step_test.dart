import 'package:amar_elaka_app/features/post/data/post_draft_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  Future<void> toDetails(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('post-new')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('category-mobile-phones')));
    await settleSaves(tester);
  }

  Finder textField(String key) => find.descendant(
    of: find.byKey(ValueKey(key)),
    matching: find.byType(TextField),
  );

  testWidgets(
    'shows title, description and the category fields; next checks them all',
    (tester) async {
      await pumpPostApp(tester);
      await toDetails(tester);
      expect(fieldLabel('শিরোনাম'), findsOneWidget);
      expect(fieldLabel('অবস্থা'), findsOneWidget); // from the field schema
      expect(fieldLabel('দাম'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('editor-next')));
      await tester.pumpAndSettle();
      expect(
        find.text('একটি শিরোনাম লিখুন — ক্রেতারা এটাই আগে দেখেন'),
        findsOneWidget,
      );
      expect(find.text('ধাপ ২/৬: বিস্তারিত'), findsOneWidget); // not moved on

      await tester.enterText(textField('post-title'), 'আইফোন ১৩ বিক্রি');
      await tester.tap(find.text('ব্যবহৃত'));
      await tester.enterText(labelledField('দাম'), '৬৫০০০');
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('editor-next')));
      await tester.pumpAndSettle();
      expect(find.text('ধাপ ৩/৬: ছবি'), findsOneWidget);
    },
  );

  testWidgets('keeps everything typed, even half-typed, across an app kill', (
    tester,
  ) async {
    final db = memoryDatabase();
    addTearDown(() => tester.runAsync(db.close));
    await pumpPostApp(tester, db: db);
    await toDetails(tester);

    await tester.enterText(textField('post-title'), 'মিরপুরে ফ্ল্যাট');
    await tester.enterText(textField('post-description'), 'লিফট আছে');
    await tester.enterText(
      labelledField('দাম'),
      '১২ হাজ',
    ); // not a valid amount yet
    await settleSaves(tester);

    // "App killed": everything torn down, only the database survives.
    await tester.pumpWidget(const SizedBox());
    final drafts = await realAsync(
      tester,
      () => PostDraftStore(db).watchUnfinished().first,
    );
    expect(drafts.single.title, 'মিরপুরে ফ্ল্যাট');
    expect(drafts.single.description, 'লিফট আছে');
    expect(drafts.single.formState['price'], '১২ হাজ');

    await pumpPostApp(tester, db: db);
    expect(
      find.text('মিরপুরে ফ্ল্যাট'),
      findsOneWidget,
    ); // listed as a draft on the Post tab
    await tester.tap(find.text('মিরপুরে ফ্ল্যাট'));
    await tester.pumpAndSettle();
    expect(find.text('ধাপ ২/৬: বিস্তারিত'), findsOneWidget);
    expect(find.text('লিফট আছে'), findsOneWidget);
    expect(find.text('১২ হাজ'), findsOneWidget);
  });
}
