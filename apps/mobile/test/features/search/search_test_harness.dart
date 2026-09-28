import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/network_photo.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/core/storage/app_database_provider.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/feed/application/feed_controller.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/post/data/posts_api.dart';
import 'package:amar_elaka_app/features/post_detail/data/engagement_api.dart';
import 'package:amar_elaka_app/features/search/data/saved_searches_api.dart';
import 'package:amar_elaka_app/features/search/data/search_api.dart';
import 'package:amar_elaka_app/features/search/domain/search_request.dart';
import 'package:amar_elaka_app/features/search/presentation/saved_searches_screen.dart';
import 'package:amar_elaka_app/features/search/presentation/search_screen.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../feed/feed_test_harness.dart';
import '../post/post_test_harness.dart';

// ---- fixtures ----------------------------------------------------------------

Map<String, dynamic> hitJson({
  String id = 'h1',
  String title = 'মিরপুরে ২ রুমের বাসা ভাড়া',
  String? price = '15000.00',
  double? distanceMeters = 850,
  bool boosted = false,
  String category = 'to-let',
}) => {
  'id': id,
  'type': 'posts',
  'tenantId': 't1',
  'name': {'bn': title, 'en': null},
  'nameTranslit': '',
  'description': null,
  'category': {
    'id': 'c-$category',
    'slug': category,
    'name': {'bn': 'টু-লেট', 'en': 'To-Let'},
  },
  'area': {'bn': 'মিরপুর ১০', 'en': 'Mirpur 10'},
  'location': null,
  'distanceMeters': distanceMeters,
  'isBoosted': boosted,
  'publishedAt': '2026-09-20T08:00:00.000Z',
  'price': price,
  'cardFields': <String, dynamic>{},
  'rating': null,
  'slug': null,
  'cover': {
    'thumbUrl': 'https://cdn.test/$id-thumb.webp',
    'thumbhash': testThumbhash,
  },
  'isVerified': false,
  'isLandmark': false,
};

/// Facets as GET /search returns them for a to-let search in Mirpur.
const facetsJson = {
  'categories': [
    {'slug': 'to-let', 'count': 12},
    {'slug': 'mobile-phones', 'count': 3},
  ],
  'price': {
    'min': '8000.00',
    'max': '40000.00',
    'buckets': [
      {'min': '0.00', 'max': '10000.00', 'count': 2},
      {'min': '10000.00', 'max': '20000.00', 'count': 7},
      {'min': '20000.00', 'max': null, 'count': 3},
    ],
  },
  'fields': {
    'condition': {
      'kind': 'values',
      'values': [
        {'value': 'used', 'count': 5},
        {'value': 'new', 'count': 2},
      ],
    },
  },
};

SearchResult searchResult({
  List<Map<String, dynamic>>? hits,
  int? total,
  double? radiusKm = 10,
  Map<String, dynamic> facets = facetsJson,
  String? nextCursor,
  List<Map<String, dynamic>> landmarks = const [],
}) {
  final list =
      hits ??
      [
        hitJson(),
        hitJson(
          id: 'h2',
          title: 'ফ্যামিলি বাসা, লিফট ও জেনারেটর সহ',
          price: '22000.00',
          distanceMeters: 1900,
          boosted: true,
        ),
      ];
  return SearchResult.fromJson({
    'query': '',
    'searchId': 's-1',
    'hits': list,
    'landmarks': landmarks,
    'nextCursor': nextCursor,
    'page': 1,
    'limit': 20,
    'totalHits': total ?? list.length,
    'scope': 'area',
    'radiusKm': radiusKm,
    'facets': facets,
    'degraded': false,
  });
}

SavedSearch savedSearch({
  String id = 'ss1',
  String name = 'basa vara',
  bool active = true,
  DateTime? pausedAt,
  int newResultCount = 3,
  AlertFrequency frequency = AlertFrequency.daily,
}) => SavedSearch.fromJson({
  'id': id,
  'name': name,
  'q': 'basa vara',
  'filters': {
    'category': 'to-let',
    'fields': <String, dynamic>{},
    'priceMin': '10000.00',
    'priceMax': '20000.00',
  },
  'center': {'lat': 23.8069, 'lng': 90.3687},
  'radiusKm': 10,
  'frequency': frequency.api,
  'active': active,
  'pausedAt': pausedAt?.toIso8601String(),
  'newResultCount': newResultCount,
  'lastAlertedAt': null,
  'createdAt': '2026-09-20T08:00:00.000Z',
});

// ---- fakes -------------------------------------------------------------------

/// Answers every search with [respond] (by default [searchResult]); records
/// requests, suggestion queries and clicks.
class FakeSearchApi implements SearchApi {
  SearchResult Function(SearchRequest request) respond = (_) => searchResult();
  SuggestResult Function(String q) suggestions = (q) => SuggestResult.fromJson({
    'query': q,
    'categories': [
      {
        'slug': 'to-let',
        'name': {'bn': 'টু-লেট / বাসা ভাড়া', 'en': 'To-Let / House Rent'},
      },
    ],
    'queries': [
      {'query': 'basa vara mirpur'},
      {'query': 'বাসা ভাড়া'},
    ],
    'listings': [
      {
        'id': 'h1',
        'tenantId': 't1',
        'title': {'bn': 'মিরপুরে ২ রুমের বাসা ভাড়া', 'en': null},
        'categorySlug': 'to-let',
      },
    ],
    'degraded': false,
  });
  List<String> trendingQueries = const ['বাসা ভাড়া', 'daktar', 'iphone'];
  AppException? failWith;

  final List<SearchRequest> requests = [];
  final List<String> suggested = [];
  final List<(String, String)> clicks = [];

  @override
  Future<SearchResult> search(
    SearchRequest request, {
    double? lat,
    double? lng,
    String? cursor,
  }) async {
    requests.add(request);
    if (failWith case final error?) throw error;
    return respond(request);
  }

  @override
  Future<SuggestResult> suggest(String q, {double? lat, double? lng}) async {
    suggested.add(q);
    return suggestions(q);
  }

  @override
  Future<TrendingResult> trending() async =>
      TrendingResult(windowHours: 24, queries: trendingQueries);

  @override
  Future<void> click(String searchId, String postId) async =>
      clicks.add((searchId, postId));
}

class FakeSavedSearchesApi implements SavedSearchesApi {
  List<SavedSearch> items = [savedSearch()];
  final List<NewSavedSearch> created = [];
  final List<(String, bool)> toggles = [];
  final List<String> deleted = [];
  AppException? createError;

  @override
  Future<SavedSearchList> list() async => SavedSearchList(
    items: items,
    newResultCount: items.fold(0, (sum, s) => sum + s.newResultCount),
    maxActive: 5,
    activeCount: items.where((s) => s.active).length,
  );

  @override
  Future<SavedSearch> create(NewSavedSearch search) async {
    if (createError case final error?) throw error;
    created.add(search);
    final saved = savedSearch(
      id: 'ss-new',
      name: search.name,
      newResultCount: 0,
      frequency: search.frequency,
    );
    items = [saved, ...items];
    return saved;
  }

  @override
  Future<SavedSearch> setActive(String id, {required bool active}) async {
    toggles.add((id, active));
    items = [
      for (final s in items)
        s.id == id
            ? savedSearch(
                id: s.id,
                name: s.name,
                active: active,
                newResultCount: s.newResultCount,
              )
            : s,
    ];
    return items.firstWhere((s) => s.id == id);
  }

  @override
  Future<void> delete(String id) async {
    deleted.add(id);
    items = [
      for (final s in items)
        if (s.id != id) s,
    ];
  }

  @override
  Future<SavedSearchNewResults> newResults(String id) async =>
      SavedSearchNewResults(
        search: items.firstWhere((s) => s.id == id),
        results: [
          postCard(
            id: 'p7',
            title: 'মিরপুরে ২ রুমের বাসা ভাড়া',
            price: '15000.00',
          ),
        ],
      );
}

// ---- the app under test -------------------------------------------------------

class SearchTestApp {
  SearchTestApp({
    required this.search,
    required this.saved,
    required this.engagement,
    required this.router,
  });

  final FakeSearchApi search;
  final FakeSavedSearchesApi saved;
  final FakeEngagementApi engagement;
  final GoRouter router;
}

/// Search, saved searches and stand-ins for the detail and login screens,
/// with fakes behind them, in Bengali.
Future<SearchTestApp> pumpSearchApp(
  WidgetTester tester, {
  FakeSearchApi? search,
  FakeSavedSearchesApi? saved,
  bool signedIn = true,
  bool located = true,
  String initialLocation = RoutePaths.search,
  ThemeData? theme,
  Size physicalSize = const Size(1080, 2400),
  Map<String, Object> prefs = const {},
}) async {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues(prefs);

  final fakeSearch = search ?? FakeSearchApi();
  final fakeSaved = saved ?? FakeSavedSearchesApi();
  final engagement = FakeEngagementApi();
  final database = memoryDatabase();
  addTearDown(() => tester.runAsync(database.close));
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(path: RoutePaths.search, builder: (_, _) => const SearchScreen()),
      GoRoute(
        path: RoutePaths.savedSearches,
        builder: (_, _) => const SavedSearchesScreen(),
        routes: [
          GoRoute(
            path: ':id',
            builder: (_, state) =>
                SavedSearchResultsScreen(id: state.pathParameters['id']!),
          ),
        ],
      ),
      GoRoute(
        path: '${RoutePaths.postDetail}/:id',
        builder: (_, state) =>
            Scaffold(body: Text('detail-${state.pathParameters['id']}')),
      ),
      GoRoute(
        path: RoutePaths.login,
        builder: (_, _) => const Scaffold(body: Text('login-screen')),
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        searchApiProvider.overrideWithValue(fakeSearch),
        savedSearchesApiProvider.overrideWithValue(fakeSaved),
        engagementApiProvider.overrideWithValue(engagement),
        postsApiProvider.overrideWithValue(FakePostsApi()),
        appDatabaseProvider.overrideWithValue(database),
        authControllerProvider.overrideWith(
          signedIn ? FakeAuthController.new : GuestAuthController.new,
        ),
        currentTenantConfigProvider.overrideWithValue(testTenant),
        viewerPositionProvider.overrideWith(
          (ref) async =>
              located ? const LocationGranted(23.8069, 90.3687) : null,
        ),
      ],
      child: NetworkPhotoOverride(
        builder: loadedPhoto,
        child: MaterialApp.router(
          debugShowCheckedModeBanner: false,
          theme: theme ?? AppTheme.light(),
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          routerConfig: router,
        ),
      ),
    ),
  );
  await settleSearch(tester);
  return SearchTestApp(
    search: fakeSearch,
    saved: fakeSaved,
    engagement: engagement,
    router: router,
  );
}

/// Lets real async work (shared preferences, Drift) and the debounce finish.
Future<void> settleSearch(WidgetTester tester) async {
  for (var i = 0; i < 4; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump(const Duration(milliseconds: 300));
    await tester.pumpAndSettle();
  }
}

/// Types [text] the way a keyboard does, then lets the debounce fire.
Future<void> typeQuery(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const ValueKey('search-field')), text);
  await settleSearch(tester);
}

/// Presses the keyboard's search key.
Future<void> submitQuery(WidgetTester tester) async {
  await tester.testTextInput.receiveAction(TextInputAction.search);
  await settleSearch(tester);
}
