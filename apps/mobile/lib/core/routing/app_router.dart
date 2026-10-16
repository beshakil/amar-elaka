import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/foundation.dart';
import 'package:go_router/go_router.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../features/account_ban/presentation/ban_screens.dart';
import '../../features/account_ban/presentation/complaint_screens.dart';
import '../../features/auth/application/auth_controller.dart';
import '../network/account_gate.dart';
import '../../features/auth/presentation/email_login_screen.dart';
import '../../features/auth/presentation/login_screen.dart';
import '../../features/auth/presentation/otp_verify_screen.dart';
import '../../features/design_system_debug/presentation/design_system_screen.dart';
import '../../features/form_preview/form_preview_screen.dart';
import '../../features/home/presentation/home_screen.dart';
import '../../features/agent/data/agent_models.dart';
import '../../features/agent/presentation/agent_capture_screen.dart';
import '../../features/agent/presentation/agent_hub_screen.dart';
import '../../features/agent/presentation/agent_queue_screen.dart';
import '../../features/agent/presentation/agent_stats_screen.dart';
import '../../features/agent/presentation/agent_today_screen.dart';
import '../../features/info/data/info_models.dart';
import '../../features/info/presentation/bazar_screens.dart';
import '../../features/info/presentation/blood_screens.dart';
import '../../features/info/presentation/emergency_screen.dart';
import '../../features/info/presentation/info_engine_screens.dart';
import '../../features/info/presentation/info_screen.dart';
import '../../features/info/presentation/lost_found_screens.dart';
import '../../features/info/presentation/prayer_screen.dart';
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
import '../../features/chat/presentation/chat_inbox_screen.dart';
import '../../features/chat/presentation/conversation_screen.dart';
import '../../features/reviews/presentation/review_screens.dart';
import '../../features/notifications/presentation/notification_preferences_screen.dart';
import '../../features/notifications/presentation/notifications_screen.dart';
import '../../features/notifications/presentation/push_rationale.dart';
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
import '../../features/verification/presentation/verification_screens.dart';
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
    ref.listen(accountGateProvider, (_, _) => notifyListeners());
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
      accountGate: ref.read(accountGateProvider),
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
        routes: [
          GoRoute(
            path: 'settings',
            builder: (context, state) => const NotificationPreferencesScreen(),
          ),
        ],
      ),
      // Chat (ADR 060). `archived` before `:id`, so it isn't read as an id.
      GoRoute(
        path: RoutePaths.chat,
        builder: (context, state) => const ChatInboxScreen(),
        routes: [
          GoRoute(
            path: 'archived',
            builder: (context, state) => const ChatInboxScreen(archived: true),
          ),
          GoRoute(
            path: ':id',
            builder: (context, state) =>
                ConversationScreen(conversationId: state.pathParameters['id']!),
          ),
        ],
      ),
      GoRoute(
        path: '${RoutePaths.storeReviews}/:storeId',
        builder: (context, state) =>
            StoreReviewsScreen(storeId: state.pathParameters['storeId']!),
      ),
      GoRoute(
        path: '${RoutePaths.writeReview}/:storeId',
        builder: (context, state) =>
            WriteReviewScreen(storeId: state.pathParameters['storeId']!),
      ),
      GoRoute(
        path: RoutePaths.pushRationale,
        builder: (context, state) => const PushRationaleScreen(),
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
          GoRoute(
            path: ':id/verification',
            builder: (context, state) =>
                StoreVerificationScreen(storeId: state.pathParameters['id']!),
          ),
        ],
      ),
      GoRoute(
        path: RoutePaths.banNotice,
        builder: (context, state) => const BanNoticeScreen(),
      ),
      GoRoute(
        path: '/account/appeal/:targetId',
        builder: (context, state) =>
            AppealScreen(targetId: state.pathParameters['targetId']!),
      ),
      GoRoute(
        path: RoutePaths.publicAppeal,
        builder: (context, state) => const PublicAppealScreen(),
      ),
      GoRoute(
        path: RoutePaths.myComplaints,
        builder: (context, state) => const MyComplaintsScreen(),
      ),
      GoRoute(
        path: RoutePaths.verification,
        builder: (context, state) => const VerificationScreen(),
      ),
      // Local information services (ADR 064). Full-screen, above the shell;
      // the emergency page is exempt from every redirect.
      GoRoute(
        path: RoutePaths.emergency,
        builder: (context, state) => const EmergencyScreen(),
      ),
      GoRoute(
        path: RoutePaths.bazar,
        builder: (context, state) => BazarBoardScreen(
          board: state.uri.queryParameters['board'] ?? 'bazar',
        ),
      ),
      GoRoute(
        path: RoutePaths.bazarEntry,
        builder: (context, state) => BazarEntryScreen(
          board: state.uri.queryParameters['board'] ?? 'bazar',
        ),
      ),
      GoRoute(
        path: RoutePaths.blood,
        builder: (context, state) => const BloodScreen(),
      ),
      GoRoute(
        path: RoutePaths.bloodRegister,
        builder: (context, state) =>
            RegisterDonorScreen(existing: state.extra as MyDonor?),
      ),
      GoRoute(
        path: RoutePaths.bloodContacts,
        builder: (context, state) => const DonorContactsScreen(),
      ),
      GoRoute(
        path: RoutePaths.bloodNewRequest,
        builder: (context, state) => const NewBloodRequestScreen(),
      ),
      GoRoute(
        path: '/info/blood/requests/:id',
        builder: (context, state) =>
            BloodRequestScreen(requestId: state.pathParameters['id']!),
      ),
      // Field agent mode (ADR 066). The API checks the role on every call.
      GoRoute(
        path: RoutePaths.agent,
        builder: (context, state) => const AgentHubScreen(),
      ),
      GoRoute(
        path: RoutePaths.agentCapture,
        builder: (context, state) => AgentCaptureScreen(
          task: state.extra is AgentTask ? state.extra! as AgentTask : null,
        ),
      ),
      GoRoute(
        path: RoutePaths.agentToday,
        builder: (context, state) => const AgentTodayScreen(),
      ),
      GoRoute(
        path: RoutePaths.agentQueue,
        builder: (context, state) => const AgentQueueScreen(),
      ),
      GoRoute(
        path: RoutePaths.agentStats,
        builder: (context, state) => const AgentStatsScreen(),
      ),
      // The info engine (ADR 065). The "new" paths come before ":id".
      GoRoute(
        path: RoutePaths.outages,
        builder: (context, state) => const OutagesScreen(),
      ),
      GoRoute(
        path: RoutePaths.notices,
        builder: (context, state) =>
            NoticesScreen(category: state.uri.queryParameters['category']),
      ),
      GoRoute(
        path: RoutePaths.noticeNew,
        builder: (context, state) => const NoticeNewScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.notices}/:id',
        builder: (context, state) =>
            NoticeDetailScreen(id: state.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.lostFound,
        builder: (context, state) => const LostFoundScreen(),
      ),
      GoRoute(
        path: RoutePaths.lostFoundNew,
        builder: (context, state) => const LostFoundNewScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.lostFound}/:id',
        builder: (context, state) =>
            LostFoundDetailScreen(id: state.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.transport,
        builder: (context, state) => const TransportScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.transport}/:id',
        builder: (context, state) =>
            RouteDetailScreen(id: state.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.govServices,
        builder: (context, state) => const GovServicesScreen(),
      ),
      GoRoute(
        path: '${RoutePaths.govServices}/:slug',
        builder: (context, state) =>
            GovServiceDetailScreen(slugOrId: state.pathParameters['slug']!),
      ),
      GoRoute(
        path: RoutePaths.directory,
        builder: (context, state) => const DirectoryScreen(),
      ),
      GoRoute(
        path: RoutePaths.prayer,
        builder: (context, state) => const PrayerScreen(),
      ),
      GoRoute(
        path: RoutePaths.agri,
        builder: (context, state) => const AgriScreen(),
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
