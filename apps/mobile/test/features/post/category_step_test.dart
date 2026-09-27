import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:amar_elaka_app/features/post/data/post_draft_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  Future<PostTestApp> openEditor(
    WidgetTester tester, {
    FakePostsApi? api,
  }) async {
    final app = await pumpPostApp(tester, api: api);
    await tester.tap(find.byKey(const ValueKey('post-new')));
    await tester.pumpAndSettle();
    return app;
  }

  testWidgets(
    'shows the postable categories of the area, with icons, and no module tiles',
    (tester) async {
      await openEditor(tester);
      expect(find.text('ধাপ ১/৬: বিভাগ'), findsOneWidget);
      expect(find.text('মোবাইল ফোন'), findsOneWidget);
      expect(find.text('টু-লেট / বাসা ভাড়া'), findsOneWidget);
      expect(find.text('রক্তদান'), findsNothing);
      expect(find.byIcon(Icons.smartphone_outlined), findsOneWidget);
    },
  );

  testWidgets('searches in Bengali or English', (tester) async {
    await openEditor(tester);
    await tester.enterText(find.byType(TextField), 'ভাড়া');
    await tester.pumpAndSettle();
    expect(find.text('টু-লেট / বাসা ভাড়া'), findsOneWidget);
    expect(find.text('মোবাইল ফোন'), findsNothing);

    await tester.enterText(find.byType(TextField), 'mobile');
    await tester.pumpAndSettle();
    expect(find.text('মোবাইল ফোন'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'হেলিকপ্টার');
    await tester.pumpAndSettle();
    expect(
      find.text('এই নামে কোনো বিভাগ নেই — অন্য শব্দে খুঁজুন'),
      findsOneWidget,
    );
  });

  testWidgets('picking a category saves it and moves on to the details', (
    tester,
  ) async {
    final app = await openEditor(tester);
    await tester.tap(find.byKey(const ValueKey('category-mobile-phones')));
    await settleSaves(tester);
    expect(find.text('ধাপ ২/৬: বিস্তারিত'), findsOneWidget);

    final drafts = await realAsync(
      tester,
      () => PostDraftStore(app.db).watchUnfinished().first,
    );
    expect(drafts.single.category?.slug, 'mobile-phones');
    expect(drafts.single.step, PostStep.details);
  });

  testWidgets('a failed load says so in Bengali, with a retry', (tester) async {
    final api = FakePostsApi()
      ..categoriesError = apiError('TENANT_NOT_FOUND', status: 404);
    await openEditor(tester, api: api);
    expect(find.text('বিভাগের তালিকা আনা যায়নি'), findsOneWidget);
    expect(
      find.text(
        'আপনার এলাকা খুঁজে পাওয়া যাচ্ছে না — অ্যাপটি বন্ধ করে আবার খুলুন।',
      ),
      findsOneWidget,
    );

    api.categoriesError = null;
    await tester.tap(find.text('আবার চেষ্টা করুন'));
    await tester.pumpAndSettle();
    expect(find.text('মোবাইল ফোন'), findsOneWidget);
  });
}
