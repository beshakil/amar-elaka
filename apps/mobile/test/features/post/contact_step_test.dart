import 'package:amar_elaka_app/core/design/widgets/app_form_controls.dart';
import 'package:amar_elaka_app/features/post/data/post_draft_store.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  Finder field(String key) => find.descendant(
    of: find.byKey(ValueKey(key)),
    matching: find.byType(TextField),
  );

  testWidgets(
    'fills name and number from the profile, the number in Bengali digits',
    (tester) async {
      await pumpPostApp(tester);
      await walkTo(tester, PostStep.contact);
      expect(find.text('ধাপ ৫/৬: যোগাযোগ'), findsOneWidget);
      expect(find.text('রহিম উদ্দিন'), findsOneWidget);
      expect(find.text('০১৭১২৩৪৫৬৭৮'), findsOneWidget);
    },
  );

  testWidgets(
    'refuses a wrong number with a specific Bengali message; saves a good one as E.164',
    (tester) async {
      final app = await pumpPostApp(tester);
      await walkTo(tester, PostStep.contact);
      await tester.enterText(field('contact-phone'), '০১২৩৪');
      await next(tester);
      expect(
        find.text(
          'সঠিক মোবাইল নম্বর দিন — ১১ অঙ্কের, ০১ দিয়ে শুরু (যেমন ০১৭১২৩৪৫৬৭৮)',
        ),
        findsOneWidget,
      );
      expect(find.text('ধাপ ৫/৬: যোগাযোগ'), findsOneWidget);

      await tester.enterText(field('contact-phone'), '০১৮১২৩৪৫৬৭৮');
      await next(tester);
      expect(find.text('ধাপ ৬/৬: দেখে নিন'), findsOneWidget);
      final draft = (await realAsync(
        tester,
        () => PostDraftStore(app.db).watchUnfinished().first,
      )).single;
      expect(draft.contactPhone, '+8801812345678');
    },
  );

  testWidgets(
    'WhatsApp needs the number shown; no phone and no chat is refused',
    (tester) async {
      await pumpPostApp(tester);
      await walkTo(tester, PostStep.contact);
      AppSwitchTile tile(String key) =>
          tester.widget<AppSwitchTile>(find.byKey(ValueKey(key)));

      await tester.tap(find.byKey(const ValueKey('contact-show-phone')));
      await tester.pumpAndSettle();
      expect(tile('contact-whatsapp').onChanged, isNull);
      expect(
        find.text('হোয়াটসঅ্যাপের জন্য ফোন নম্বর দেখানো চালু রাখতে হবে'),
        findsOneWidget,
      );

      await tester.tap(find.byKey(const ValueKey('contact-chat')));
      await next(tester);
      expect(
        find.text(
          'এভাবে ক্রেতারা যোগাযোগ করতে পারবেন না — ফোন অথবা চ্যাট অন্তত একটি চালু রাখুন',
        ),
        findsOneWidget,
      );
    },
  );
}
