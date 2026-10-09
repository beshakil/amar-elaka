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
import '../../features/map_debug/presentation/map_debug_screen.dart';
import '../../features/post/presentation/editor/post_editor_screen.dart';
import '../../features/post/presentation/editor/post_result_screen.dart';
import '../../features/post/presentation/my_posts/my_posts_screen.dart';
import '../../features/post_detail/presentation/post_detail_screen.dart';
import '../../features/post/presentation/post_screen.dart';
import '../../features/profile/presentation/profile_completion_screen.dart';
import '../../features/profile/presentation/profile_screen.dart';
import '../../features/search/presentation/saved_searches_screen.dart';
import '../../features/search/presentation/search_screen.dart';
import '../../features/splash/presentation/splash_screen.dart';
import '../../features/tenant_bootstrap/application/tenant_bootstrap_controller.dart';
import '../../features/tenant_bootstrap/domain/tenant_bootstrap_state.dart';
import '../../features/tenant_bootstrap/presentation/location_permission_screen.dart';
import '../../features/tenant_bootstrap/presentation/tenant_confirm_screen.dart';
import '../../features/tenant_bootstrap/presentation/tenant_picker_screen.dart';
import '../../features/notifications/presentation/notifications_screen.dart';
import '../../features/offline_map/presentation/offline_map_screen.dart';
import '../../features/place_detail/presentation/place_detail_screen.dart';
import '../../features/place_feedback/presentation/place_suggest_screen.dart';
import '../../features/my_store/presentation/create_store_screen.dart';
import '../../features/my_store/presentation/edit_store_screen.dart';
import '../../features/my_store/presentation/hours_editor_screen.dart';
import '../../features/my_store/presentation/my_store_screen.dart';
import '../../features/my_store/presentation/staff_screen.dart';
import '../../features/my_store/presentation/stock_screen.dart';
import '../../features/saved/presentation/saved_screen.dart';
import '../../features/seller_dashboard/presentation/seller_dashboard_screen.dart';
import '../../features/store/presentation/store_screen.dart';
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
        // Reached by redirect (TenantBootstrapConfirmNearby), which carries
        // no `extra`: the candidate comes from that state (state.extra! crashed
        // the first time location found an area, found on a device).
        builder: (context, state) => switch (state.extra) {
          final TenantSummary candidate => TenantConfirmScreen(
            candidate: candidate,
          ),
          _ => switch (ref.read(tenantBootstrapControllerProvider).value) {
            TenantBootstrapConfirmNearby(:final candidate) =>
              TenantConfirmScreen(candidate: candidate),
            _ => const TenantPickerScreen(),
          },
        },
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
        // The phone travels in `extra`; a rebuild without it (a deep link, a
        // restored stack) goes back to the phone step instead of crashing.
        builder: (context, state) => switch (state.extra) {
          final OtpVerifyArgs args => OtpVerifyScreen(args: args),
          _ => const LoginScreen(),
        },
      ),
      GoRoute(
        path: RoutePaths.emailLogin,
        builder: (context, state) => const EmailLoginScreen(),
      ),
      GoRoute(
        path: RoutePaths.profileCompletion,
        builder: (context, state) => const ProfileCompletionScreen(),
      ),
      // Post flows sit above the tab shell: full screen, no bottom nav.
      GoRoute(
        path: '${RoutePaths.postEditor}/:draftId',
        builder: (context, state) =>
            PostEditorScreen(draftId: state.pathParameters['draftId']!),
      ),
      GoRoute(
        path: RoutePaths.postResult,
        // A rebuild without `extra` (an auth refresh, a restored stack) shows
        // the seller's posts rather than crashing.
        builder: (context, state) => switch (state.extra) {
          final PostResultArgs args => PostResultScreen(args: args),
          _ => const MyPostsScreen(),
        },
      ),
      GoRoute(
        path: RoutePaths.myPosts,
        builder: (context, state) => const MyPostsScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.postDetail}/:id',
        builder: (context, state) =>
            PostDetailScreen(postId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.search,
        builder: (context, state) => const SearchScreen(),
      ),
      GoRoute(
        path: RoutePaths.savedSearches,
        builder: (context, state) => const SavedSearchesScreen(),
        routes: [
          GoRoute(
            path: ':id',
            builder: (context, state) =>
                SavedSearchResultsScreen(id: state.pathParameters['id']!),
          ),
        ],
      ),
      GoRoute(
        path: RoutePaths.saved,
        builder: (context, state) => const SavedScreen(),
      ),
      GoRoute(
        path: RoutePaths.notifications,
        builder: (context, state) => const NotificationsScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.place}/:id',
        builder: (context, state) =>
            PlaceDetailScreen(placeId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: '${RoutePaths.placeSuggest}/:id',
        builder: (context, state) =>
            PlaceSuggestScreen(placeId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.offlineMap,
        builder: (context, state) => const OfflineMapScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.store}/:slug',
        builder: (context, state) =>
            StoreScreen(slug: state.pathParameters['slug']!),
      ),
      GoRoute(
        path: RoutePaths.myStore,
        builder: (context, state) => const MyStoreScreen(),
        routes: [
          GoRoute(
            path: 'new',
            builder: (context, state) => const CreateStoreScreen(),
          ),
          GoRoute(
            path: ':id/edit',
            builder: (context, state) =>
                EditStoreScreen(storeId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: ':id/hours',
            builder: (context, state) =>
                HoursEditorScreen(storeId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: ':id/staff',
            builder: (context, state) =>
                StaffScreen(storeId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: ':id/stock',
            builder: (context, state) =>
                StockScreen(storeId: state.pathParameters['id']!),
          ),
          GoRoute(
            path: ':id/dashboard',
            builder: (context, state) =>
                SellerDashboardScreen(storeId: state.pathParameters['id']!),
          ),
        ],
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
      if (kDebugMode)
        GoRoute(
          path: RoutePaths.mapDebug,
          builder: (context, state) => const MapDebugScreen(),
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
