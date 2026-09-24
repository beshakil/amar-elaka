import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/auth/domain/auth_session_state.dart';
import '../../features/tenant_bootstrap/domain/tenant_bootstrap_state.dart';
import 'route_paths.dart';

const authRoutes = {
  RoutePaths.login,
  RoutePaths.otpVerify,
  RoutePaths.emailLogin,
};

const _tenantFlowRoutes = {
  RoutePaths.splash,
  RoutePaths.locationPermission,
  RoutePaths.tenantConfirm,
  RoutePaths.tenantPicker,
};

/// Pure redirect decision — kept free of `GoRouter`/`Ref` so it's directly
/// unit-testable. `AppRouter` only wires the two provider reads into this.
///
/// Two phases: first, get the tenant flow to wherever it needs to be
/// (location rationale → confirm → picker → ready) regardless of auth
/// state — tenant resolution and auth are orthogonal. Once the tenant is
/// `Ready`, auth is guest-permissive: unauthenticated only gets bounced
/// *out* of the now-finished tenant flow (to home), never *into*
/// `/auth/login` — guests reach the shell tabs directly. Authenticated
/// users get bounced away from auth/tenant-flow routes to home.
String? computeRedirect({
  required AsyncValue<TenantBootstrapState> tenantState,
  required AuthSessionState authState,
  required String location,
}) {
  if (tenantState.isLoading || tenantState.hasError) {
    return location == RoutePaths.splash ? null : RoutePaths.splash;
  }

  final targetTenantRoute = switch (tenantState.requireValue) {
    TenantBootstrapNeedsLocationDecision() => RoutePaths.locationPermission,
    TenantBootstrapConfirmNearby() => RoutePaths.tenantConfirm,
    TenantBootstrapNeedsSelection() => RoutePaths.tenantPicker,
    TenantBootstrapReady() => null,
  };
  if (targetTenantRoute != null) {
    return location == targetTenantRoute ? null : targetTenantRoute;
  }

  return switch (authState) {
    AuthSessionUnknown() =>
      location == RoutePaths.splash ? null : RoutePaths.splash,
    AuthSessionUnauthenticated() =>
      _tenantFlowRoutes.contains(location) ? RoutePaths.home : null,
    AuthSessionAuthenticated() =>
      (authRoutes.contains(location) || _tenantFlowRoutes.contains(location))
          ? RoutePaths.home
          : null,
  };
}
