import 'dart:convert';
import 'dart:io';

import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/network/account_gate.dart';
import 'package:amar_elaka_app/core/platform/external_apps.dart';
import 'package:amar_elaka_app/core/routing/deep_links.dart';
import 'package:amar_elaka_app/core/routing/redirect_logic.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/features/auth/domain/auth_session_state.dart';
import 'package:amar_elaka_app/features/info/application/bazar_entry_form.dart';
import 'package:amar_elaka_app/features/info/data/emergency_repository.dart';
import 'package:amar_elaka_app/features/info/data/info_api.dart';
import 'package:amar_elaka_app/features/info/data/info_models.dart';
import 'package:amar_elaka_app/features/info/presentation/emergency_screen.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/domain/tenant_bootstrap_state.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Local information services on the phone (ADR 064): the emergency page
/// never fails (kept copy → bundled numbers), the bazar fast entry, routing.

AppDatabase _memoryDatabase() => AppDatabase.forTesting(
  DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true),
);

final _bundled = File(
  'assets/emergency/national_hotlines.json',
).readAsStringSync();

Map<String, dynamic> _livePage({String version = 'v1'}) => {
  'version': version,
  'generatedAt': '2026-10-15T00:00:00Z',
  'refreshAfterSeconds': 3600,
  'radiusKm': 15,
  'national': [
    {
      'id': 'h1',
      'serviceType': 'national_emergency',
      'name': {'bn': 'জাতীয় জরুরি সেবা', 'en': 'National Emergency Service'},
      'description': {'bn': null, 'en': null},
      'dial': '999',
    },
  ],
  'groups': [
    {
      'serviceType': 'hospital',
      'contacts': [
        {
          'id': 'c1',
          'tenantId': 't1',
          'serviceType': 'hospital',
          'name': {'bn': 'উপজেলা স্বাস্থ্য কমপ্লেক্স', 'en': null},
          'phones': ['+8801711000000'],
          'address': null,
          'location': {'lat': 23.8, 'lng': 90.4},
          'is24h': true,
          'availabilityNote': null,
          'lastVerifiedAt': null,
          'distanceMeters': 820,
        },
      ],
    },
  ],
};

class _FakeInfoApi implements InfoApi {
  Map<String, dynamic>? page;
  int emergencyCalls = 0;

  @override
  Future<Map<String, dynamic>> emergencyJson({double? lat, double? lng}) async {
    emergencyCalls++;
    final p = page;
    if (p == null) throw const NetworkException();
    return p;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError();
}

class _FakeApps implements ExternalApps {
  final opened = <Uri>[];

  @override
  Future<bool> canOpen(Uri uri) async => true;

  @override
  Future<bool> open(Uri uri) async {
    opened.add(uri);
    return true;
  }

  @override
  Future<void> share(String text) async {}
}

void main() {
  group('EmergencyRepository', () {
    late AppDatabase db;
    late _FakeInfoApi api;
    var now = DateTime(2026, 10, 15, 9);

    EmergencyRepository repo() => EmergencyRepository(
      db,
      api,
      loadAsset: (_) async => _bundled,
      now: () => now,
    );

    setUp(() {
      db = _memoryDatabase();
      api = _FakeInfoApi();
      now = DateTime(2026, 10, 15, 9);
    });
    tearDown(() => db.close());

    test(
      'with nothing kept and no network: the bundled national numbers',
      () async {
        final s = await repo().local('t1');
        expect(s.source, EmergencySource.bundled);
        expect(s.page.national.map((h) => h.dial), contains('999'));
        expect(await repo().refresh('t1'), isNull);
      },
    );

    test(
      'adds the tenant config’s local contacts to the bundled page',
      () async {
        await db
            .into(db.emergencyContactCache)
            .insert(
              EmergencyContactCacheCompanion.insert(
                tenantId: 't1',
                serviceType: 'police',
                nameBn: 'মিরপুর থানা',
                phones: const ['+8801320000000'],
                is24h: true,
              ),
            );
        final s = await repo().local('t1');
        expect(s.page.groups.single.serviceType, 'police');
      },
    );

    test('keeps a fetched page and shows it with no network', () async {
      api.page = _livePage();
      final live = await repo().refresh('t1');
      expect(live!.source, EmergencySource.live);

      api.page = null; // offline from here on
      final kept = await repo().local('t1');
      expect(kept.source, EmergencySource.cached);
      expect(kept.page.groups.single.contacts.single.phones, [
        '+8801711000000',
      ]);
      expect(await repo().refresh('t1'), isNull);
      expect((await repo().local('t1')).source, EmergencySource.cached);
    });

    test(
      'refreshes in the background only when the kept copy is due',
      () async {
        api.page = _livePage();
        await repo().refresh('t1');
        expect(api.emergencyCalls, 1);
        await repo().refreshIfStale('t1');
        expect(api.emergencyCalls, 1);
        now = now.add(const Duration(hours: 2));
        await repo().refreshIfStale('t1');
        expect(api.emergencyCalls, 2);
      },
    );

    test('the bundled asset carries the migration’s hotlines', () {
      final page = EmergencyPage.fromJson(
        jsonDecode(_bundled) as Map<String, dynamic>,
      );
      expect(
        page.national.map((h) => h.dial),
        containsAll(['999', '16163', '16263', '109', '1098', '333']),
      );
    });
  });

  group('EmergencyScreen', () {
    testWidgets('opens offline with the bundled numbers and one tap dials', (
      tester,
    ) async {
      final db = _memoryDatabase();
      addTearDown(db.close);
      final apps = _FakeApps();
      final api = _FakeInfoApi();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            emergencyRepositoryProvider.overrideWithValue(
              EmergencyRepository(db, api, loadAsset: (_) async => _bundled),
            ),
            externalAppsProvider.overrideWithValue(apps),
            // No area picked yet (or none kept): the bundled page.
            currentTenantConfigProvider.overrideWithValue(null),
          ],
          child: const MaterialApp(
            locale: Locale('bn'),
            supportedLocales: AppLocalizations.supportedLocales,
            localizationsDelegates: [
              AppLocalizations.delegate,
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: EmergencyScreen(),
          ),
        ),
      );
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 100)),
      );
      await tester.pumpAndSettle();

      expect(find.text('জাতীয় জরুরি সেবা'), findsOneWidget);
      expect(find.textContaining('ইন্টারনেট নেই'), findsOneWidget);
      await tester.tap(find.text('৯৯৯'));
      expect(apps.opened, [Uri(scheme: 'tel', path: '999')]);
    });
  });

  group('BazarEntryForm', () {
    BazarEntrySheet sheet() => BazarEntrySheet.fromJson({
      'date': '2026-10-15',
      'earliestDate': '2026-10-14',
      'items': [
        {
          'commodityId': 'onion',
          'code': 'onion',
          'name': {'bn': 'পেঁয়াজ', 'en': 'Onion'},
          'group': 'vegetables',
          'unit': 'kg',
          'entered': null,
          'previous': {'min': '50.00', 'max': '55.00'},
        },
        {
          'commodityId': 'rice',
          'code': 'rice-coarse',
          'name': {'bn': 'মোটা চাল', 'en': 'Coarse rice'},
          'group': 'rice_grains',
          'unit': 'kg',
          'entered': null,
          'previous': null,
        },
      ],
    });

    test('prefills yesterday and skips blank rows', () {
      final form = BazarEntryForm(sheet());
      expect(form.minAt(0), '50');
      expect(form.maxAt(0), '55');
      expect(form.minAt(1), '');
      expect(form.filled, 1);
      expect(form.lines().single.toJson(), {
        'commodityId': 'onion',
        'unitCode': 'kg',
        'minPrice': '50.00',
        'maxPrice': '55.00',
      });
    });

    test('takes Bengali digits and a single price as min = max', () {
      final form = BazarEntryForm(sheet())..setMin(1, '৫৮');
      final rice = form.lines().last;
      expect((rice.min, rice.max), ('58.00', '58.00'));
    });

    test('refuses a max below the min', () {
      final form = BazarEntryForm(sheet())
        ..setMin(0, '60')
        ..setMax(0, '55');
      expect(form.firstInvalid, 0);
    });
  });

  group('routing', () {
    test('notification deep links open the blood screens', () {
      expect(
        appRouteForDeepLink('/info/blood/requests/r1'),
        RoutePaths.bloodRequestFor('r1'),
      );
      expect(
        appRouteForDeepLink('/info/blood/me/contacts'),
        RoutePaths.bloodContacts,
      );
    });

    test('the emergency page is never redirected away from', () {
      for (final gate in AccountGate.values) {
        expect(
          computeRedirect(
            tenantState: const AsyncLoading<TenantBootstrapState>(),
            authState: const AuthSessionUnknown(),
            location: RoutePaths.emergency,
            accountGate: gate,
          ),
          isNull,
        );
      }
    });
  });
}
