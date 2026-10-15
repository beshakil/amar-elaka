import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/verification/application/evidence_uploader.dart';
import 'package:amar_elaka_app/features/verification/data/verification_api.dart';
import 'package:amar_elaka_app/features/verification/data/verification_models.dart';
import 'package:amar_elaka_app/features/verification/presentation/verification_screens.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

const storeId = 's1';

Map<String, dynamic> requestJson({
  String status = 'submitted',
  String? reason,
  String? note,
  String level = 'identity_checked',
}) => {
  'id': 'v1',
  'subjectType': level == 'identity_checked' ? 'member' : 'store',
  'subjectId': 'x',
  'level': level,
  'status': status,
  'rejectionReason': reason,
  'note': note,
  'expiresAt': null,
  'createdAt': '2026-10-01T10:00:00.000Z',
};

class FakeVerificationApi implements VerificationApi {
  FakeVerificationApi({
    this.level = 'phone_verified',
    this.request = 'ok',
    this.items = const [],
    this.ownerIdentityChecked = true,
  });

  String level;
  String request;
  List<Map<String, dynamic>> items;
  bool ownerIdentityChecked;
  ApiException? failNextSubmit;
  final identities = <({String nid, String selfie})>[];
  final businesses = <({String licence, String front})>[];

  @override
  Future<MyVerifications> mine() async => MyVerifications.fromJson({
    'level': level,
    'identityRequest': request,
    'items': items,
  });

  @override
  Future<StoreVerification> store(String storeId) async =>
      StoreVerification.fromJson({
        'level': level,
        'request': request,
        'ownerIdentityChecked': ownerIdentityChecked,
        'items': items,
      });

  @override
  Future<void> submitIdentity({
    required String nid,
    required String selfieMediaId,
  }) async {
    if (failNextSubmit case final e?) {
      failNextSubmit = null;
      throw e;
    }
    identities.add((nid: nid, selfie: selfieMediaId));
    request = 'open_request';
    items = [requestJson()];
  }

  @override
  Future<void> submitBusiness(
    String storeId, {
    required String licenceMediaId,
    required String shopFrontMediaId,
  }) async {
    businesses.add((licence: licenceMediaId, front: shopFrontMediaId));
    request = 'open_request';
    items = [requestJson(level: 'business_verified')];
  }

  @override
  Future<String> uploadEvidence(File file, {String? storeId}) =>
      throw UnimplementedError('the tests upload through a fake uploader');
}

/// Every pick returns the same (nonexistent) path; the thumbnail just fails
/// to load, which the screen tolerates.
class FakePicker extends ImagePicker {
  int picks = 0;
  final sources = <ImageSource>[];

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    double? maxWidth,
    double? maxHeight,
    int? imageQuality,
    CameraDevice preferredCameraDevice = CameraDevice.rear,
    bool requestFullMetadata = true,
  }) async {
    picks++;
    sources.add(source);
    return XFile('/nonexistent/photo-$picks.jpg');
  }
}

ApiException apiError(String code, {Object? details}) => ApiException(
  ApiErrorBody(statusCode: 409, error: code, message: code, details: details),
);

Future<void> pumpScreen(
  WidgetTester tester,
  Widget screen,
  FakeVerificationApi api,
  List<({String path, String? storeId})> uploads,
) async {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => screen),
      GoRoute(
        path: RoutePaths.verification,
        builder: (_, _) => const Text('identity-screen'),
      ),
    ],
  );
  addTearDown(router.dispose);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        verificationApiProvider.overrideWithValue(api),
        evidenceUploaderProvider.overrideWithValue((path, {storeId}) async {
          uploads.add((path: path, storeId: storeId));
          return 'media-${uploads.length}';
        }),
      ],
      child: MaterialApp.router(
        theme: AppTheme.light(),
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('identity', () {
    testWidgets('a Bengali NID and a selfie: sent as digits, field cleared', (
      tester,
    ) async {
      final api = FakeVerificationApi();
      final picker = FakePicker();
      final uploads = <({String path, String? storeId})>[];
      await pumpScreen(
        tester,
        VerificationScreen(picker: picker),
        api,
        uploads,
      );
      expect(find.text('ফোন যাচাইকৃত'), findsOneWidget);

      // Submit stays off until there is a selfie.
      await tester.tap(find.byKey(const ValueKey('verification-submit')));
      await tester.pump();
      expect(api.identities, isEmpty);

      await tester.enterText(
        find.byKey(const ValueKey('verification-nid')),
        '১২৩ ৪৫৬ ৭৮৯০',
      );
      await tester.tap(find.text('ছবি তুলুন'));
      await tester.pumpAndSettle();
      expect(picker.sources, [ImageSource.camera]);

      await tester.tap(find.byKey(const ValueKey('verification-submit')));
      await tester.pumpAndSettle();

      expect(api.identities.single, (nid: '1234567890', selfie: 'media-1'));
      expect(uploads.single.storeId, isNull);
      expect(find.text('জমা হয়েছে। মডারেটর দেখে জানাবেন।'), findsOneWidget);
      // Refreshed: the request now waits, the form (and the number) is gone.
      expect(find.byKey(const ValueKey('verification-nid')), findsNothing);
      expect(find.text('জমা হয়েছে — মডারেটর দেখছেন'), findsOneWidget);
    });

    testWidgets('a wrong-length NID is caught before anything is sent', (
      tester,
    ) async {
      final api = FakeVerificationApi();
      final uploads = <({String path, String? storeId})>[];
      await pumpScreen(
        tester,
        VerificationScreen(picker: FakePicker()),
        api,
        uploads,
      );
      await tester.enterText(
        find.byKey(const ValueKey('verification-nid')),
        '12345',
      );
      await tester.tap(find.text('ছবি তুলুন'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('verification-submit')));
      await tester.pumpAndSettle();

      expect(
        find.text('NID নম্বর ১০, ১৩ বা ১৭ সংখ্যার হতে হবে।'),
        findsOneWidget,
      );
      expect(uploads, isEmpty);
      expect(api.identities, isEmpty);
    });

    testWidgets('a refusal from the server is said in Bengali', (tester) async {
      final api = FakeVerificationApi(level: 'none')
        ..failNextSubmit = apiError(
          'VERIFICATION_NOT_ALLOWED',
          details: {'reason': 'phone_unverified'},
        );
      await pumpScreen(
        tester,
        VerificationScreen(picker: FakePicker()),
        api,
        [],
      );
      await tester.enterText(
        find.byKey(const ValueKey('verification-nid')),
        '1234567890123',
      );
      await tester.tap(find.text('ছবি তুলুন'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('verification-submit')));
      await tester.pumpAndSettle();
      expect(find.text('আগে ফোন নম্বর যাচাই করুন।'), findsOneWidget);
    });

    testWidgets('waiting: no form', (tester) async {
      final api = FakeVerificationApi(
        request: 'open_request',
        items: [requestJson()],
      );
      await pumpScreen(tester, const VerificationScreen(), api, []);
      expect(find.byKey(const ValueKey('verification-nid')), findsNothing);
      expect(
        find.text('আপনার আবেদন জমা আছে। মডারেটর দেখে জানাবেন।'),
        findsOneWidget,
      );
    });

    testWidgets('rejected: the reason and the note, and a new form', (
      tester,
    ) async {
      final api = FakeVerificationApi(
        items: [
          requestJson(
            status: 'rejected',
            reason: 'document_unclear',
            note: 'সেলফিতে মুখ অন্ধকার',
          ),
        ],
      );
      await pumpScreen(tester, const VerificationScreen(), api, []);
      expect(find.text('যাচাই হয়নি'), findsOneWidget);
      expect(find.text('ছবি বা কাগজ পরিষ্কার পড়া যায়নি।'), findsOneWidget);
      expect(find.text('সেলফিতে মুখ অন্ধকার'), findsOneWidget);
      expect(find.byKey(const ValueKey('verification-nid')), findsOneWidget);
    });

    testWidgets('expired: the badge says phone again, renewal offered', (
      tester,
    ) async {
      final api = FakeVerificationApi(items: [requestJson(status: 'expired')]);
      await pumpScreen(tester, const VerificationScreen(), api, []);
      expect(find.text('ফোন যাচাইকৃত'), findsOneWidget);
      expect(find.text('মেয়াদ শেষ — আবার যাচাই করুন'), findsOneWidget);
      expect(find.byKey(const ValueKey('verification-nid')), findsOneWidget);
    });
  });

  group('store', () {
    testWidgets('the owner verifies identity first', (tester) async {
      final api = FakeVerificationApi(ownerIdentityChecked: false);
      await pumpScreen(
        tester,
        const StoreVerificationScreen(storeId: storeId),
        api,
        [],
      );
      expect(
        find.text('দোকান যাচাইয়ের আগে মালিকের পরিচয় যাচাই লাগবে।'),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('store-verification-submit')),
        findsNothing,
      );
      await tester.tap(
        find.byKey(const ValueKey('store-verification-identity')),
      );
      await tester.pumpAndSettle();
      expect(find.text('identity-screen'), findsOneWidget);
    });

    testWidgets('licence and shop front: both uploaded to the store, sent', (
      tester,
    ) async {
      final api = FakeVerificationApi(level: 'identity_checked');
      final picker = FakePicker();
      final uploads = <({String path, String? storeId})>[];
      await pumpScreen(
        tester,
        StoreVerificationScreen(storeId: storeId, picker: picker),
        api,
        uploads,
      );

      // The licence: camera or gallery.
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('verification-photo-licence')),
          matching: find.byType(TextButton),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('গ্যালারি থেকে'));
      await tester.pumpAndSettle();
      // The shop front: camera only.
      await tester.tap(
        find.descendant(
          of: find.byKey(const ValueKey('verification-photo-shop-front')),
          matching: find.byType(TextButton),
        ),
      );
      await tester.pumpAndSettle();
      expect(picker.sources, [ImageSource.gallery, ImageSource.camera]);

      await tester.tap(find.byKey(const ValueKey('store-verification-submit')));
      await tester.pumpAndSettle();

      expect(api.businesses.single, (licence: 'media-1', front: 'media-2'));
      expect(uploads.map((u) => u.storeId), [storeId, storeId]);
      expect(find.text('জমা হয়েছে — মডারেটর দেখছেন'), findsOneWidget);
    });
  });

  test('NID numbers: Bengali digits, spaces and dashes; 10, 13 or 17', () {
    expect(normalizeNid('১২৩৪৫৬৭৮৯০'), '1234567890');
    expect(normalizeNid('123-456-7890-123'), '1234567890123');
    expect(normalizeNid('1234 5678 9012 34567'), '12345678901234567');
    expect(normalizeNid('12345678901'), isNull);
    expect(normalizeNid('12345abcde'), isNull);
    expect(normalizeNid(''), isNull);
  });

  test('deep links from the verification notifications', () {
    expect(appRouteForDeepLink('/verification'), RoutePaths.verification);
    expect(
      appRouteForDeepLink('/stores/s9/verification'),
      RoutePaths.storeVerificationFor('s9'),
    );
    expect(
      appRouteForDeepLink('/stores/s9/review'),
      RoutePaths.writeReviewFor('s9'),
    );
  });
}
