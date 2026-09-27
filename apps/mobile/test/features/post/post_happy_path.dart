import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

/// The whole create flow, start to finish, as a seller does it: Post tab →
/// category → details → a photo → location → contact → preview → post →
/// "live now" → my posts. Run as a widget test in CI
/// (test/features/post/post_happy_path_test.dart) and on a device
/// (integration_test/post_happy_path_test.dart).
Future<void> runPostHappyPath(WidgetTester tester) async {
  final dir = (await tester.runAsync(
    () => Directory.systemTemp.createTemp('happy_path'),
  ))!;
  addTearDown(() => dir.delete(recursive: true));
  final photo = (await tester.runAsync(
    () => File('${dir.path}/phone.jpg').writeAsBytes(List.filled(4000, 7)),
  ))!;
  final app = await pumpPostApp(
    tester,
    picker: FakeImagePicker([photo.path]),
    uploadDir: dir,
  );

  // Post tab → new post → category.
  await tester.tap(find.byKey(const ValueKey('post-new')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('category-mobile-phones')));
  await settleSaves(tester);

  // Details.
  await tester.enterText(
    find.descendant(
      of: find.byKey(const ValueKey('post-title')),
      matching: find.byType(TextField),
    ),
    'আইফোন ১৩, ১২৮ জিবি',
  );
  await tester.enterText(
    find.descendant(
      of: find.byKey(const ValueKey('post-description')),
      matching: find.byType(TextField),
    ),
    'বক্স সহ, ব্যাটারি ৯০%',
  );
  await tester.tap(find.text('ব্যবহৃত'));
  await tester.enterText(labelledField('ব্র্যান্ড'), 'অ্যাপল');
  await tester.enterText(labelledField('দাম'), '৬৫,০০০');
  await next(tester);

  // Photos: one, uploaded in the background.
  await tester.tap(find.byIcon(Icons.add_a_photo_outlined));
  await tester.pumpAndSettle();
  await tester.tap(find.text('গ্যালারি থেকে বেছে নিন'));
  await pumpUntil(tester, () => app.transport.confirmed.length == 1);
  await next(tester);

  // Location: the phone's position, its address.
  await settleSaves(tester);
  expect(find.text('মিরপুর ১০, ঢাকা'), findsOneWidget);
  await next(tester);

  // Contact: from the profile, WhatsApp on.
  expect(find.text('০১৭১২৩৪৫৬৭৮'), findsOneWidget);
  await tester.tap(find.byKey(const ValueKey('contact-whatsapp')));
  await next(tester);

  // Preview, then post.
  expect(find.text('ধাপ ৬/৬: দেখে নিন'), findsOneWidget);
  expect(find.text('৳ ৬৫,০০০'), findsNWidgets(2));
  await tester.tap(find.byKey(const ValueKey('editor-next')));
  // Real file IO (the sent photos' files are cleaned up): let it run.
  await pumpUntil(
    tester,
    () => find.text('আপনার পোস্ট এখন লাইভ!').evaluate().isNotEmpty,
  );
  await tester.pumpAndSettle();

  // "Live now".
  expect(find.text('আপনার পোস্ট এখন লাইভ!'), findsOneWidget);
  final sent = app.api.created.single;
  expect(sent.body, containsPair('title', 'আইফোন ১৩, ১২৮ জিবি'));
  expect(sent.body, containsPair('description', 'বক্স সহ, ব্যাটারি ৯০%'));
  expect(sent.body['fields'], {
    'condition': 'used',
    'brand': 'অ্যাপল',
    'price': '65000.00',
  });
  expect(sent.body['mediaIds'], ['m1']);
  expect(sent.body, containsPair('showWhatsapp', true));

  // My posts: it's there, under live.
  await tester.tap(find.text('আমার পোস্টে যান'));
  await tester.pumpAndSettle();
  expect(find.text('লাইভ ১'), findsOneWidget);
  expect(find.text('আইফোন ১৩, ১২৮ জিবি'), findsOneWidget);
}
