import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../features/auth/application/auth_controller.dart';
import '../../features/auth/presentation/email_login_screen.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/otp_verify_screen.dart';
import '../../features/design_system_debug/presentation/design_system_screen.dart';
import '../../features/form_preview/form_preview_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/info/presentation/info_screen.dart';
import '../../features/map/presentation/map_screen.dart';
import '../../features/post/presentation/post_screen.dart';
import '../../features/profile/presentation/profile_completion_screen.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/splash/presentation/splash_screen.dart';
import '../../features/tenant_bootstrap/application/tenant_bootstrap_controller.dart';
import '../../features/tenant_bootstrap/presentation/location_permission_screen.dart';
import '../../features/tenant_bootstrap/presentation/tenant_confirm_screen.dart';
import '../../features/tenant_bootstrap/presentation/tenant_picker_screen.dart';
import 'app_shell.dart';
import 'redirect_logic.dart';
import 'route_paths.dart';

part 'app_router.g.dart';

/// Bridges Riverpod state changes into a `Listenable` so `GoRouter` knows
/// to re-run `redirect` whenever tenant-bootstrap or auth state changes —
/// `GoRouter` itself has no notion of Riverpod.
class _RouterRefreshNotifier extends ChangeNotifier {
  _RouterRefreshNotifier(Ref ref) {
    ref.listen(tenantBootstrapControllerProvider, (_, _) => notifyListeners());
    ref.listen(authControllerProvider, (_, _) => notifyListeners());
  }
}

@riverpod
GoRouter appRouter(Ref ref) {
  final refresh = _RouterRefreshNotifier(ref);
  ref.onDispose(refresh.dispose);

  return GoRouter(
    initialLocation: RoutePaths.splash,
    refreshListenable: refresh,
    redirect: (context, state) => computeRedirect(
      tenantState: ref.read(tenantBootstrapControllerProvider),
      authState: ref.read(authControllerProvider),
      location: state.matchedLocation,
    ),
    routes: [
      GoRoute(
        path: RoutePaths.splash,
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(
        path: RoutePaths.locationPermission,
        builder: (context, state) => const LocationPermissionScreen(),
      ),
      GoRoute(
        path: RoutePaths.tenantConfirm,
        builder: (context, state) =>
            TenantConfirmScreen(candidate: state.extra! as TenantSummary),
      ),
      GoRoute(
        path: RoutePaths.tenantPicker,
        builder: (context, state) => const TenantPickerScreen(),
      ),
      GoRoute(
        path: RoutePaths.login,
        builder: (context, state) => const LoginScreen(),
      ),
      GoRoute(
        path: RoutePaths.otpVerify,
        builder: (context, state) =>
            OtpVerifyScreen(args: state.extra! as OtpVerifyArgs),
      ),
      GoRoute(
        path: RoutePaths.emailLogin,
        builder: (context, state) => const EmailLoginScreen(),
      ),
      GoRoute(
        path: RoutePaths.profileCompletion,
        builder: (context, state) => const ProfileCompletionScreen(),
      ),
      // Debug-only: `kDebugMode` is a compile-time constant, so this branch
      // (and DesignSystemScreen's tree) is tree-shaken out of release builds.
      if (kDebugMode)
        GoRoute(
          path: RoutePaths.designSystem,
          builder: (context, state) => const DesignSystemScreen(),
        ),
      if (kDebugMode)
        GoRoute(
          path: RoutePaths.formPreview,
          builder: (context, state) => const FormPreviewScreen(),
        ),
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) =>
            AppShell(navigationShell: navigationShell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: RoutePaths.home,
                builder: (context, state) => const HomeScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: RoutePaths.map,
                builder: (context, state) => const MapScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: RoutePaths.post,
                builder: (context, state) => const PostScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: RoutePaths.info,
                builder: (context, state) => const InfoScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: RoutePaths.profile,
                builder: (context, state) => const ProfileScreen(),
              ),
            ],
          ),
        ],
      ),
    ],
  );
}
