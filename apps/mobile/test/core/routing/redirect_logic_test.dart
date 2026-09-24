import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/routing/redirect_logic.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/auth/domain/auth_session_state.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/domain/tenant_bootstrap_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

const _tenant = TenantSummary(
  id: 't1',
  slug: 'mirpur',
  nameBn: 'মিরপুর',
  nameEn: 'Mirpur',
  mapCenter: LatLng(lat: 0, lng: 0),
  districtNameBn: 'ঢাকা',
  districtNameEn: 'Dhaka',
);

final _config = TenantConfig(
  id: 't1',
  slug: 'mirpur',
  nameBn: 'মিরপুর',
  nameEn: 'Mirpur',
  defaultLocale: 'bn',
  mapCenter: const LatLng(lat: 0, lng: 0),
  radiusKm: null,
  branding: const TenantBranding(logoStorageKey: null),
  featureFlags: const {},
  enabledCategories: const [],
  emergencyNumbers: const [],
  support: const TenantSupport(
    phoneE164: null,
    email: null,
    whatsappE164: null,
  ),
);

const _me = MeResult(
  userId: 'u1',
  phone: '+8801000000000',
  email: null,
  displayName: 'Test User',
  avatarStorageKey: null,
  tenantId: 't1',
  memberId: 'm1',
  role: 'member',
);

AsyncValue<TenantBootstrapState> _ready({bool isStale = false}) =>
    AsyncValue.data(TenantBootstrapReady(_config, isStale: isStale));

void main() {
  group('computeRedirect — tenant flow (auth-independent)', () {
    test('parks on splash while tenant bootstrap is loading', () {
      expect(
        computeRedirect(
          tenantState: const AsyncValue.loading(),
          authState: const AuthSessionUnknown(),
          location: RoutePaths.home,
        ),
        RoutePaths.splash,
      );
    });

    test(
      'parks on splash when tenant bootstrap errored (splash shows the retry UI)',
      () {
        expect(
          computeRedirect(
            tenantState: AsyncValue.error(Exception('boom'), StackTrace.empty),
            authState: const AuthSessionUnknown(),
            location: RoutePaths.home,
          ),
          RoutePaths.splash,
        );
      },
    );

    test('sends to the location-permission screen on first launch', () {
      expect(
        computeRedirect(
          tenantState: const AsyncValue.data(
            TenantBootstrapNeedsLocationDecision(),
          ),
          authState: const AuthSessionUnknown(),
          location: RoutePaths.splash,
        ),
        RoutePaths.locationPermission,
      );
    });

    test('sends to the confirm screen once a nearby candidate is found', () {
      expect(
        computeRedirect(
          tenantState: const AsyncValue.data(
            TenantBootstrapConfirmNearby(_tenant),
          ),
          authState: const AuthSessionUnknown(),
          location: RoutePaths.locationPermission,
        ),
        RoutePaths.tenantConfirm,
      );
    });

    test('sends to the picker when denied/no-match/skip', () {
      expect(
        computeRedirect(
          tenantState: const AsyncValue.data(
            TenantBootstrapNeedsSelection([_tenant]),
          ),
          authState: const AuthSessionUnknown(),
          location: RoutePaths.splash,
        ),
        RoutePaths.tenantPicker,
      );
    });

    test(
      'does not redirect away from the tenant-flow screen it already targets',
      () {
        for (final entry in [
          (
            const AsyncValue<TenantBootstrapState>.data(
              TenantBootstrapNeedsLocationDecision(),
            ),
            RoutePaths.locationPermission,
          ),
          (
            const AsyncValue<TenantBootstrapState>.data(
              TenantBootstrapConfirmNearby(_tenant),
            ),
            RoutePaths.tenantConfirm,
          ),
          (
            const AsyncValue<TenantBootstrapState>.data(
              TenantBootstrapNeedsSelection([_tenant]),
            ),
            RoutePaths.tenantPicker,
          ),
        ]) {
          expect(
            computeRedirect(
              tenantState: entry.$1,
              authState: const AuthSessionUnknown(),
              location: entry.$2,
            ),
            isNull,
            reason: 'at ${entry.$2}',
          );
        }
      },
    );
  });

  group('computeRedirect — guest browsing once the tenant is ready', () {
    test(
      'a guest lands on home once tenant bootstrap resolves from splash',
      () {
        expect(
          computeRedirect(
            tenantState: _ready(),
            authState: const AuthSessionUnauthenticated(),
            location: RoutePaths.splash,
          ),
          RoutePaths.home,
        );
      },
    );

    test(
      'a stale-but-ready tenant behaves the same as a fresh one for routing',
      () {
        expect(
          computeRedirect(
            tenantState: _ready(isStale: true),
            authState: const AuthSessionUnauthenticated(),
            location: RoutePaths.splash,
          ),
          RoutePaths.home,
        );
      },
    );

    test('a guest reaches the shell tabs directly, no bounce to login', () {
      for (final location in [
        RoutePaths.home,
        RoutePaths.map,
        RoutePaths.post,
        RoutePaths.info,
        RoutePaths.profile,
      ]) {
        expect(
          computeRedirect(
            tenantState: _ready(),
            authState: const AuthSessionUnauthenticated(),
            location: location,
          ),
          isNull,
          reason: 'at $location',
        );
      }
    });

    test('a guest who explicitly navigated to an auth route stays there', () {
      for (final location in [
        RoutePaths.login,
        RoutePaths.otpVerify,
        RoutePaths.emailLogin,
      ]) {
        expect(
          computeRedirect(
            tenantState: _ready(),
            authState: const AuthSessionUnauthenticated(),
            location: location,
          ),
          isNull,
          reason: 'at $location',
        );
      }
    });

    test(
      'a guest still sitting on a tenant-flow route once ready gets sent home',
      () {
        for (final location in [
          RoutePaths.locationPermission,
          RoutePaths.tenantConfirm,
          RoutePaths.tenantPicker,
        ]) {
          expect(
            computeRedirect(
              tenantState: _ready(),
              authState: const AuthSessionUnauthenticated(),
              location: location,
            ),
            RoutePaths.home,
            reason: 'at $location',
          );
        }
      },
    );
  });

  group('computeRedirect — authenticated once the tenant is ready', () {
    test(
      'sends an authenticated user away from auth/tenant-flow routes to home',
      () {
        for (final location in [
          RoutePaths.login,
          RoutePaths.splash,
          RoutePaths.tenantPicker,
          RoutePaths.otpVerify,
        ]) {
          expect(
            computeRedirect(
              tenantState: _ready(),
              authState: const AuthSessionAuthenticated(_me),
              location: location,
            ),
            RoutePaths.home,
            reason: 'from $location',
          );
        }
      },
    );

    test('leaves an authenticated user on an already-in-app route', () {
      expect(
        computeRedirect(
          tenantState: _ready(),
          authState: const AuthSessionAuthenticated(_me),
          location: RoutePaths.profile,
        ),
        isNull,
      );
    });

    test(
      'leaves an authenticated user on profile completion (not an auth/tenant-flow route)',
      () {
        expect(
          computeRedirect(
            tenantState: _ready(),
            authState: const AuthSessionAuthenticated(_me),
            location: RoutePaths.profileCompletion,
          ),
          isNull,
        );
      },
    );
  });
}
