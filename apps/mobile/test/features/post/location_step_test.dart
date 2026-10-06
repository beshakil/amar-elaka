import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/post/data/post_draft_store.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'post_test_harness.dart';

void main() {
  testWidgets('starts at the phone location and shows its address in Bengali', (
    tester,
  ) async {
    final api = FakePostsApi();
    final app = await pumpPostApp(tester, api: api);
    await walkTo(tester, PostStep.location);
    expect(find.text('ধাপ ৪/৬: অবস্থান'), findsOneWidget);
    expect(find.text('মিরপুর ১০, ঢাকা'), findsOneWidget);
    // A post's pin: the server maps the purpose to the minimum Barikoi fields.
    expect(api.lastReversePurpose, 'post_location');
    expect(
      find.byKey(const ValueKey('location-outside-warning')),
      findsNothing,
    );

    final draft = (await realAsync(
      tester,
      () => PostDraftStore(app.db).watchUnfinished().first,
    )).single;
    expect((draft.lat, draft.lng), (23.8069, 90.3687));
    expect(draft.addressLabel, 'মিরপুর ১০, ঢাকা');
  });

  testWidgets(
    'outside the area: warns, names the area, and still lets the user go on',
    (tester) async {
      final api = FakePostsApi()
        ..outsideBoundary = true
        ..needsReview = true;
      await pumpPostApp(tester, api: api);
      await walkTo(tester, PostStep.location);
      expect(
        find.byKey(const ValueKey('location-outside-warning')),
        findsOneWidget,
      );
      expect(
        find.textContaining('পিনটি মিরপুর-এর সীমানার বাইরে'),
        findsOneWidget,
      );
      expect(find.textContaining('একজন মডারেটর দেখে নেবেন'), findsOneWidget);

      await next(tester);
      expect(find.text('ধাপ ৫/৬: যোগাযোগ'), findsOneWidget);
    },
  );

  testWidgets(
    'without location permission: says so, starts at the area centre, search still works',
    (tester) async {
      final api = FakePostsApi()
        ..searchResults = [
          const GeocodeResult(
            label: 'Shewrapara, Dhaka',
            labelBn: 'শেওড়াপাড়া, ঢাকা',
            location: LatLng(lat: 23.7907, lng: 90.3760),
            area: 'Mirpur',
            city: 'Dhaka',
            source: 'barikoi',
            distanceMeters: null,
          ),
        ];
      final app = await pumpPostApp(
        tester,
        api: api,
        location: FakeLocationService(const LocationDenied()),
      );
      await walkTo(tester, PostStep.location);
      expect(
        find.text(
          'লোকেশনের অনুমতি দেওয়া হয়নি — মানচিত্রে নিজে পিন বসান বা ঠিকানা খুঁজুন',
        ),
        findsOneWidget,
      );

      api.addressLabelBn = 'শেওড়াপাড়া, ঢাকা';
      await tester.enterText(
        find.descendant(
          of: find.byKey(const ValueKey('location-search')),
          matching: find.byType(TextField),
        ),
        'শেওড়াপাড়া',
      );
      await tester.pump(const Duration(milliseconds: 500));
      await tester.pumpAndSettle();
      // Barikoi's results carry its credit (placeholder wording, ADR 043):
      // under the search results, and under the address Barikoi gave.
      expect(
        find.byKey(const ValueKey('barikoi-attribution')),
        findsNWidgets(2),
      );
      await tester.tap(find.widgetWithText(ListTile, 'শেওড়াপাড়া, ঢাকা'));
      await settleSaves(tester);

      final draft = (await realAsync(
        tester,
        () => PostDraftStore(app.db).watchUnfinished().first,
      )).single;
      expect((draft.lat, draft.lng), (23.7907, 90.3760));
      expect(find.byKey(const ValueKey('location-address')), findsOneWidget);
    },
  );
}
