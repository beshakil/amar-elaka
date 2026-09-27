import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/post/data/post_draft_store.dart';
import 'package:amar_elaka_app/features/post/domain/post_draft.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  Future<void> submit(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('editor-next')));
    await settleSaves(tester);
  }

  testWidgets(
    'a trusted seller: "live now", sent once with an Idempotency-Key, draft gone',
    (tester) async {
      final app = await pumpPostApp(tester);
      await walkTo(tester, PostStep.preview);
      await submit(tester);

      expect(find.text('আপনার পোস্ট এখন লাইভ!'), findsOneWidget);
      final sent = app.api.created.single;
      expect(sent.key, startsWith('post-'));
      expect(sent.body, containsPair('submit', true));
      expect(sent.body['fields'], {'condition': 'used', 'price': '65000.00'});
      expect(sent.body['location'], {'lat': 23.8069, 'lng': 90.3687});
      expect(sent.body['contactPhone'], '+8801712345678');
      final drafts = await realAsync(
        tester,
        () => PostDraftStore(app.db).watchUnfinished().first,
      );
      expect(drafts, isEmpty);
    },
  );

  testWidgets('waiting for review: says so, with the area\'s usual review time', (
    tester,
  ) async {
    final api = FakePostsApi()..createStatus = 'pending';
    await pumpPostApp(tester, api: api);
    await walkTo(tester, PostStep.preview);
    await submit(tester);
    expect(find.text('পোস্টটি রিভিউতে আছে'), findsOneWidget);
    expect(
      find.text(
        'সাধারণত ১২ ঘণ্টার মধ্যে যাচাই শেষ হয়। অনুমোদন হলে আপনাকে জানিয়ে দেব।',
      ),
      findsOneWidget,
    );
  });

  testWidgets(
    'offline: kept and queued, and the same key is used when it is sent later',
    (tester) async {
      final api = FakePostsApi()..createErrors.add(const NetworkException());
      final app = await pumpPostApp(tester, api: api);
      await walkTo(tester, PostStep.preview);
      await submit(tester);

      expect(
        find.text(
          'ইন্টারনেট নেই — পোস্টটি সংরক্ষিত আছে, সংযোগ ফিরলে নিজে থেকেই পাঠানো হবে',
        ),
        findsOneWidget,
      );
      final queued = (await realAsync(
        tester,
        () => PostDraftStore(app.db).queued(),
      )).single;
      expect(queued.submitState, DraftSubmitState.queued);
      expect(
        find.text('ইন্টারনেট ফিরলে নিজে থেকেই পাঠানো হবে', findRichText: true),
        findsNothing,
      );
      expect(
        find.textContaining('ইন্টারনেট ফিরলে নিজে থেকেই পাঠানো হবে'),
        findsOneWidget,
      ); // on the Post tab

      // The app is closed, and opened again with a connection: DraftSync
      // resends with the draft's own key.
      await tester.pumpWidget(const SizedBox());
      await pumpPostApp(tester, api: api, db: app.db, online: true);
      await pumpUntil(tester, () => api.created.isNotEmpty);
      expect(api.created.single.key, queued.idempotencyKey);
    },
  );

  testWidgets(
    'refused by the server: a specific Bengali reason, and the post stays editable',
    (tester) async {
      final api = FakePostsApi()
        ..createErrors.add(
          apiError(
            'POST_LIMIT_REACHED',
            status: 429,
            details: {'limit': 'active', 'max': 20},
          ),
        );
      final app = await pumpPostApp(tester, api: api);
      await walkTo(tester, PostStep.preview);
      await submit(tester);
      expect(
        find.text(
          'আপনার ২০টি সক্রিয় পোস্ট আছে — এটাই সর্বোচ্চ। একটিকে \'বিক্রি হয়েছে\' করুন বা মুছে ফেলুন, তারপর আবার চেষ্টা করুন।',
        ),
        findsOneWidget,
      );
      final draft = (await realAsync(
        tester,
        () => PostDraftStore(app.db).watchUnfinished().first,
      )).single;
      expect(draft.submitState, DraftSubmitState.editing);
      expect(draft.lastErrorCode, 'POST_LIMIT_REACHED');
    },
  );

  testWidgets(
    'a field the server refused sends the user back to the details step',
    (tester) async {
      final api = FakePostsApi()
        ..createErrors.add(apiError('FIELD_VALIDATION_FAILED', status: 422));
      await pumpPostApp(tester, api: api);
      await walkTo(tester, PostStep.preview);
      await submit(tester);
      expect(find.text('ধাপ ২/৬: বিস্তারিত'), findsOneWidget);
      expect(
        find.text(
          'কিছু তথ্য এই বিভাগের নিয়মের সাথে মেলেনি — \'বিস্তারিত\' ধাপে লাল চিহ্নিত ঘরগুলো ঠিক করুন।',
        ),
        findsOneWidget,
      );
    },
  );
}
