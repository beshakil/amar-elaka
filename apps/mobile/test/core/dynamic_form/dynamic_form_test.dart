import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/app_form_controls.dart';
import 'package:amar_elaka_app/core/design/widgets/app_text_field.dart';
import 'package:amar_elaka_app/core/dynamic_form/dynamic_form.dart';
import 'package:amar_elaka_app/core/dynamic_form/field_schema.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fixtures.dart';

void main() {
  Future<List<Map<String, Object>>> pumpForm(
    WidgetTester tester,
    CategoryFieldSchema schema,
  ) async {
    final submitted = <Map<String, Object>>[];
    tester.view.physicalSize = const Size(1080, 6000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.light(),
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: SingleChildScrollView(
            child: DynamicForm(
              schema: schema,
              validationContext: fixtureContext,
              onSubmit: submitted.add,
            ),
          ),
        ),
      ),
    );
    return submitted;
  }

  /// The text field whose label is exactly [label].
  Finder field(String label) => find.byWidgetPredicate(
    (w) =>
        w is TextField &&
        w.decoration?.label is AppFieldLabel &&
        (w.decoration!.label! as AppFieldLabel).label == label,
  );

  /// The select field (bottom-sheet picker) whose label is [label].
  Finder select(String label) =>
      find.byWidgetPredicate((w) => w is AppSelectField && w.label == label);

  testWidgets('shows Bengali errors on submit and submits nothing', (
    tester,
  ) async {
    final submitted = await pumpForm(tester, fixtureSchema('to-let'));
    await tester.tap(find.text('জমা দিন'));
    await tester.pumpAndSettle();

    expect(find.text('এই ঘরটি পূরণ করুন।'), findsOneWidget); // rent
    expect(find.text('একটি বেছে নিন।'), findsOneWidget); // property type
    expect(find.text('একটি তারিখ বেছে নিন।'), findsOneWidget); // available from
    expect(submitted, isEmpty);
  });

  testWidgets('conditional fields appear only for the right property type', (
    tester,
  ) async {
    await pumpForm(tester, fixtureSchema('to-let'));
    expect(find.textContaining('শোবার ঘর'), findsNothing);

    await tester.tap(select('ধরন'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('ফ্ল্যাট').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('শোবার ঘর'), findsOneWidget);
    expect(find.textContaining('কাদের জন্য'), findsOneWidget);

    await tester.tap(select('ধরন'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('দোকান').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('শোবার ঘর'), findsNothing);
  });

  testWidgets(
    'one submit shows every missing field, conditional ones included',
    (tester) async {
      await pumpForm(tester, fixtureSchema('to-let'));
      await tester.tap(select('ধরন'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('ফ্ল্যাট').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('জমা দিন'));
      await tester.pumpAndSettle();

      // Rent and bedrooms (required while shown for a flat)…
      expect(find.text('এই ঘরটি পূরণ করুন।'), findsNWidgets(2));
      // …tenant type (chips)…
      expect(find.text('একটি বেছে নিন।'), findsOneWidget);
      // …and the date.
      expect(find.text('একটি তারিখ বেছে নিন।'), findsOneWidget);
    },
  );

  testWidgets('accepts Latin digits and shows money grouped in Bengali', (
    tester,
  ) async {
    await pumpForm(tester, fixtureSchema('to-let'));
    final rent = field('মাসিক ভাড়া');
    await tester.enterText(rent, '1234567');
    await tester.testTextInput.receiveAction(TextInputAction.next);
    await tester.pumpAndSettle();
    expect(find.text('১২,৩৪,৫৬৭'), findsOneWidget);
    final input = tester.widget<TextField>(rent);
    expect(
      input.keyboardType,
      const TextInputType.numberWithOptions(decimal: true),
    );
  });

  testWidgets('submits API-shaped values', (tester) async {
    final submitted = await pumpForm(tester, fixtureSchema('rent-a-car'));
    await tester.tap(select('গাড়ির ধরন'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('মাইক্রোবাস (হায়েস/নোয়া)').last);
    await tester.pumpAndSettle();
    await tester.enterText(field('আসন'), '১১');
    await tester.enterText(field('প্রতিদিনের ভাড়া'), '৬,৫০০');
    await tester.tap(find.text('হ্যাঁ'));
    await tester.tap(find.text('ড্রাইভার ছাড়া'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('জমা দিন'));
    await tester.pumpAndSettle();

    expect(submitted, [
      {
        'vehicle_type': 'microbus',
        'seats': 11,
        'ac': true,
        'driver_option': 'self_drive',
        'price': '6500.00',
      },
    ]);
  });
}
