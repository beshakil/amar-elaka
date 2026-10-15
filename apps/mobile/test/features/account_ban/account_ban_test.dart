import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/network/account_gate.dart';
import 'package:amar_elaka_app/core/network/interceptors/account_state_interceptor.dart';
import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/account_ban/data/ban_api.dart';
import 'package:amar_elaka_app/features/account_ban/data/ban_models.dart';
import 'package:amar_elaka_app/features/account_ban/presentation/ban_screens.dart';
import 'package:amar_elaka_app/features/account_ban/presentation/complaint_screens.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

Map<String, dynamic> noticeJson({
  String kind = 'area',
  String severity = 'banned',
  String reference = 'BN-0A1B2C3D4E',
  Map<String, dynamic>? appeal,
  bool canAppeal = true,
  String? expiresAt = '2026-11-12T10:00:00.000Z',
}) => {
  'kind': kind,
  'id': 'ban-1',
  'reference': reference,
  'severity': severity,
  'reasonCode': 'scam',
  'areaName': kind == 'area' ? {'bn': 'মিরপুর', 'en': 'Mirpur'} : null,
  'startsAt': '2026-10-12T10:00:00.000Z',
  'expiresAt': expiresAt,
  'permanent': expiresAt == null,
  'appeal': appeal,
  'canAppeal': canAppeal,
};

class FakeBanApi implements BanApi {
  FakeBanApi({List<Map<String, dynamic>>? notices})
    : notices_ = notices ?? [noticeJson()];

  List<Map<String, dynamic>> notices_;
  final appeals = <(String, String)>[];
  final otpRequests = <String>[];
  final publicAppeals =
      <({String phone, String token, String reference, String statement})>[];
  final complaints =
      <
        ({
          String type,
          String? subjectId,
          String? postId,
          ComplaintCategory category,
        })
      >[];

  @override
  Future<List<BanNotice>> notices() async => banNoticesOf(notices_);

  @override
  Future<String> appeal({
    required String targetId,
    required String statement,
  }) async {
    appeals.add((targetId, statement));
    notices_ = [
      noticeJson(
        appeal: {
          'id': 'a1',
          'reference': 'AP-1234567890',
          'status': 'submitted',
        },
        canAppeal: false,
      ),
    ];
    return 'AP-1234567890';
  }

  @override
  Future<Duration> requestAppealOtp(String phone) async {
    otpRequests.add(phone);
    return const Duration(seconds: 60);
  }

  @override
  Future<PublicAppealStatus> appealStatus({
    required String phone,
    required String otp,
  }) async => PublicAppealStatus.fromJson({
    'items': [
      noticeJson(
        kind: 'platform',
        severity: 'terminated',
        reference: 'BL-FFEEDDCCBB',
        expiresAt: null,
      ),
    ],
    'appealsLeftToday': 1,
    'appealToken': 'token-abcdefghijklmnopqrstuvwxyz',
  });

  @override
  Future<String> publicAppeal({
    required String phone,
    required String appealToken,
    required String reference,
    required String statement,
  }) async {
    publicAppeals.add((
      phone: phone,
      token: appealToken,
      reference: reference,
      statement: statement,
    ));
    return 'AP-0987654321';
  }

  @override
  Future<String> complain({
    required String subjectType,
    required ComplaintCategory category,
    required String description,
    String? subjectId,
    String? postId,
  }) async {
    complaints.add((
      type: subjectType,
      subjectId: subjectId,
      postId: postId,
      category: category,
    ));
    return 'CP-1111111111';
  }

  @override
  Future<List<MyComplaint>> myComplaints() async => [];
}

Future<ProviderContainer> pumpWith(
  WidgetTester tester,
  FakeBanApi api,
  Widget home, {
  AccountGate gate = AccountGate.open,
}) async {
  tester.view.physicalSize = const Size(1080, 3200);
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  final router = GoRouter(
    routes: [
      GoRoute(path: '/', builder: (_, _) => home),
      GoRoute(
        path: '/account/appeal/:id',
        builder: (_, s) => AppealScreen(targetId: s.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.home,
        builder: (_, _) => const Text('home-screen'),
      ),
    ],
  );
  addTearDown(router.dispose);
  final container = ProviderContainer(
    overrides: [banApiProvider.overrideWithValue(api)],
  );
  addTearDown(container.dispose);
  container.read(accountGateProvider.notifier).set(gate);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
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
  return container;
}

void main() {
  group('the ban notice', () {
    testWidgets(
      'why, how long, which area and the reference; then the appeal',
      (tester) async {
        final api = FakeBanApi();
        await pumpWith(
          tester,
          api,
          const BanNoticeScreen(),
          gate: AccountGate.banned,
        );
        expect(find.text('নিষিদ্ধ অ্যাকাউন্ট'), findsOneWidget);
        expect(find.textContaining('প্রতারণা'), findsOneWidget);
        expect(find.textContaining('মিরপুর এলাকায়'), findsOneWidget);
        expect(find.textContaining('BN-0A1B2C3D4E'), findsWidgets);
        expect(find.textContaining('পর্যন্ত'), findsOneWidget);
        // A banned session can't back out of the notice, only log out.
        expect(find.byKey(const ValueKey('ban-logout')), findsOneWidget);

        await tester.tap(
          find.byKey(const ValueKey('ban-appeal-BN-0A1B2C3D4E')),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const ValueKey('appeal-statement')),
          'টাকা ফেরত দিয়েছি',
        );
        await tester.pump();
        await tester.tap(find.byKey(const ValueKey('appeal-submit')));
        await tester.pumpAndSettle();
        expect(api.appeals.single, ('ban-1', 'টাকা ফেরত দিয়েছি'));
        expect(find.textContaining('AP-1234567890'), findsOneWidget);
      },
    );

    testWidgets('an appeal waiting shows its reference instead of the button', (
      tester,
    ) async {
      final api = FakeBanApi(
        notices: [
          noticeJson(
            appeal: {
              'id': 'a1',
              'reference': 'AP-1234567890',
              'status': 'submitted',
            },
            canAppeal: false,
          ),
        ],
      );
      await pumpWith(tester, api, const BanNoticeScreen());
      expect(find.byKey(const ValueKey('ban-appeal-status')), findsOneWidget);
      expect(find.textContaining('সিদ্ধান্তের অপেক্ষায়'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('ban-appeal-BN-0A1B2C3D4E')),
        findsNothing,
      );
    });

    testWidgets('no ban left: the gate opens and the app comes back', (
      tester,
    ) async {
      final api = FakeBanApi(notices: []);
      final container = await pumpWith(
        tester,
        api,
        const BanNoticeScreen(),
        gate: AccountGate.banned,
      );
      await tester.tap(find.byKey(const ValueKey('ban-continue')));
      await tester.pumpAndSettle();
      expect(container.read(accountGateProvider), AccountGate.open);
      expect(find.text('home-screen'), findsOneWidget);
    });
  });

  testWidgets(
    'a terminated person appeals without a session: phone → code → ban → statement',
    (tester) async {
      final api = FakeBanApi();
      await pumpWith(
        tester,
        api,
        const PublicAppealScreen(),
        gate: AccountGate.terminated,
      );
      await tester.enterText(
        find.byKey(const ValueKey('public-appeal-phone')),
        '01712345678',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('public-appeal-send-code')));
      await tester.pumpAndSettle();
      expect(api.otpRequests.single, '+8801712345678');

      await tester.enterText(
        find.byKey(const ValueKey('public-appeal-code')),
        '123456',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('public-appeal-check')));
      await tester.pumpAndSettle();
      expect(find.text('বন্ধ অ্যাকাউন্ট'), findsOneWidget);
      expect(find.textContaining('সব এলাকায়'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('ban-appeal-BL-FFEEDDCCBB')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('public-appeal-statement')),
        'নম্বরটা আমার না',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('public-appeal-submit')));
      await tester.pumpAndSettle();
      expect(api.publicAppeals.single, (
        phone: '+8801712345678',
        token: 'token-abcdefghijklmnopqrstuvwxyz',
        reference: 'BL-FFEEDDCCBB',
        statement: 'নম্বরটা আমার না',
      ));
      expect(find.byKey(const ValueKey('public-appeal-done')), findsOneWidget);
    },
  );

  testWidgets(
    'a complaint about the person on a post sends the post, never a user id',
    (tester) async {
      final api = FakeBanApi();
      await pumpWith(
        tester,
        api,
        Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => showComplaintSheet(
                context,
                subjectType: 'user',
                postId: 'p1',
                subjectName: 'করিম',
              ),
              child: const Text('open'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('করিম-এর বিরুদ্ধে অভিযোগ'), findsOneWidget);
      // Category and words are both needed.
      await tester.tap(find.byKey(const ValueKey('complaint-scam')));
      await tester.enterText(
        find.byKey(const ValueKey('complaint-description')),
        '৫০০০ টাকা অগ্রিম নিয়ে ফোন বন্ধ',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('complaint-submit')));
      await tester.pumpAndSettle();
      expect(api.complaints.single, (
        type: 'user',
        subjectId: null,
        postId: 'p1',
        category: ComplaintCategory.scam,
      ));
      expect(find.textContaining('CP-1111111111'), findsOneWidget);
    },
  );

  test(
    'a 403 ACCOUNT_BANNED or ACCOUNT_TERMINATED sets the gate; other errors do not',
    () {
      final gates = <AccountGate>[];
      final interceptor = AccountStateInterceptor(gates.add);
      DioException error(int status, String code) => DioException(
        requestOptions: RequestOptions(path: '/x'),
        response: Response(
          requestOptions: RequestOptions(path: '/x'),
          statusCode: status,
          data: {'error': code},
        ),
      );
      final handler = _PassThrough();
      for (final e in [
        error(403, 'ACCOUNT_BANNED'),
        error(403, 'ACCOUNT_RESTRICTED'),
        error(403, 'ACCOUNT_TERMINATED'),
        error(401, 'ACCOUNT_BANNED'),
      ]) {
        interceptor.onError(e, handler);
      }
      expect(gates, [AccountGate.banned, AccountGate.terminated]);
      // Every error still reaches the caller.
      expect(handler.passed, 4);
    },
  );

  test('deep links from the ban and complaint notifications', () {
    expect(appRouteForDeepLink('/account/bans'), RoutePaths.banNotice);
    expect(appRouteForDeepLink('/complaints'), RoutePaths.myComplaints);
    expect(appRouteForDeepLink('/moderation/appeals'), isNull);
  });
}

class _PassThrough extends ErrorInterceptorHandler {
  int passed = 0;

  @override
  void next(DioException err) => passed++;
}
