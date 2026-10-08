import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/routing/app_router.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/auth/domain/auth_session_state.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/application/tenant_bootstrap_controller.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/domain/tenant_bootstrap_state.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/presentation/tenant_confirm_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Location found an area: the redirect sends the app to "is this your
/// area?", and a redirect carries no `extra`. The route must take the
/// candidate from the bootstrap state (`state.extra!` crashed on a device).
const _mirpur = TenantSummary(
  id: 't-mirpur',
  slug: 'mirpur',
  nameBn: 'মিরপুর',
  nameEn: 'Mirpur',
  mapCenter: LatLng(lat: 23.81, lng: 90.365),
  districtNameBn: 'ঢাকা',
  districtNameEn: 'Dhaka',
);

class _FoundNearby extends TenantBootstrapController {
  @override
  Future<TenantBootstrapState> build() async =>
      const TenantBootstrapConfirmNearby(_mirpur);
}

class _Guest extends AuthController {
  @override
  AuthSessionState build() => const AuthSessionUnauthenticated();
}

void main() {
  testWidgets('the confirm screen opens by redirect, with the found area', (
    tester,
  ) async {
    final container = ProviderContainer(
      overrides: [
        tenantBootstrapControllerProvider.overrideWith(_FoundNearby.new),
        authControllerProvider.overrideWith(_Guest.new),
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp.router(
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          routerConfig: container.read(appRouterProvider),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(find.byType(TenantConfirmScreen), findsOneWidget);
    expect(find.textContaining('মিরপুর'), findsWidgets);
  });
}
