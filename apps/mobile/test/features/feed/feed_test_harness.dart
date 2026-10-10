import 'dart:convert';
import 'dart:typed_data';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/network_photo.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/platform/external_apps.dart';
import 'package:amar_elaka_app/core/routing/app_router.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/core/storage/app_database_provider.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/auth/domain/auth_session_state.dart';
import 'package:amar_elaka_app/features/feed/application/feed_controller.dart';
import 'package:amar_elaka_app/features/feed/data/feed_api.dart';
import 'package:amar_elaka_app/features/feed/domain/feed_query.dart';
import 'package:amar_elaka_app/features/feed/presentation/feed_screen.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/post/data/posts_api.dart';
import 'package:amar_elaka_app/features/post_detail/data/engagement_api.dart';
import 'package:amar_elaka_app/features/post_detail/presentation/post_detail_screen.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:thumbhash/thumbhash.dart' as th;

import '../post/post_test_harness.dart';

// ---- fixtures ----------------------------------------------------------------

/// A real thumbhash (a warm gradient), as the API would send it.
final String testThumbhash = () {
  const w = 16;
  const h = 12;
  final rgba = Uint8List(w * h * 4);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      final i = (y * w + x) * 4;
      rgba[i] = 200 + x * 3;
      rgba[i + 1] = 120 + y * 5;
      rgba[i + 2] = 60;
      rgba[i + 3] = 255;
    }
  }
  return base64Encode(th.rgbaToThumbHash(w, h, rgba));
}();

FeedPostCard postCard({
  String id = 'p1',
  String title = 'আইফোন ১৩, ১২৮ জিবি',
  String? price = '65000.00',
  bool withCover = true,
  double? distanceMeters = 1234,
  List<String> badges = const [],
  bool isSaved = false,
  bool isSold = false,
}) => FeedPostCard(
  id: id,
  tenantId: 't1',
  title: title,
  price: price,
  cover: withCover
      ? CoverImage(
          url: 'https://cdn.test/$id-card.webp',
          thumbhash: testThumbhash,
        )
      : null,
  distanceMeters: distanceMeters,
  area: const OptionalName(bn: 'মিরপুর ১০', en: 'Mirpur 10'),
  badges: badges,
  createdAt: DateTime.utc(2026, 9, 20),
  isSaved: isSaved,
  isSold: isSold,
);

Map<String, dynamic> postCardJson(FeedPostCard card) => {
  'kind': 'post',
  ...card.toJson(),
  'cover': card.cover?.toJson(),
  'area': card.area?.toJson(),
  'createdAt': card.createdAt.toIso8601String(),
};

const bazarJson = {
  'kind': 'bazar_prices',
  'date': '2026-09-28',
  'items': [
    {
      'commodity': 'rice-coarse',
      'name': {'bn': 'মোটা চাল', 'en': 'Coarse rice'},
      'unit': 'kg',
      'minPrice': '52.00',
      'maxPrice': '56.00',
    },
  ],
};

const emergencyJson = {
  'kind': 'emergency',
  'hotlines': [
    {
      'serviceType': 'national',
      'name': {'bn': 'জাতীয় জরুরি সেবা', 'en': 'National emergency'},
      'dial': '999',
    },
  ],
};

/// A feed page as the API sends it (raw JSON, what the cache keeps).
String feedPageJson(List<Map<String, Object?>> items, {String? nextCursor}) =>
    jsonEncode({
      'items': items,
      'nextCursor': nextCursor,
      'scope': 'area',
      'radiusKm': 5,
    });

PostDetail postDetail({
  String id = 'p1',
  String title = 'আইফোন ১৩, ১২৮ জিবি',
  String description = 'বক্স সহ, ব্যাটারি ৯০%। কোনো দাগ নেই।',
  bool isMine = false,
  bool isSaved = false,
  bool isSold = false,
  List<String> channels = const ['call', 'whatsapp', 'sms'],
  bool loginRequired = false,
  List<FeedPostCard>? similar,
}) => PostDetail.fromJson({
  'id': id,
  'tenantId': 't1',
  'status': isSold ? 'sold' : 'live',
  'isSold': isSold,
  'title': title,
  'description': description,
  'price': '65000.00',
  'priceType': 'negotiable',
  'currency': 'BDT',
  'category': {
    'id': 'c1',
    'slug': 'mobile-phones',
    'name': {'bn': 'মোবাইল ফোন', 'en': 'Mobile phones'},
  },
  'fieldSchemaVersion': 1,
  'fields': [
    {
      'key': 'condition',
      'type': 'select',
      'label': {'bn': 'অবস্থা', 'en': 'Condition'},
      'value': 'used',
      'optionLabels': [
        {'bn': 'ব্যবহৃত', 'en': 'Used'},
      ],
    },
    {
      'key': 'brand',
      'type': 'text',
      'label': {'bn': 'ব্র্যান্ড', 'en': 'Brand'},
      'value': 'অ্যাপল',
    },
    {
      'key': 'storage',
      'type': 'number',
      'label': {'bn': 'স্টোরেজ (জিবি)', 'en': 'Storage (GB)'},
      'value': 128,
    },
    {
      'key': 'price',
      'type': 'money',
      'label': {'bn': 'দাম', 'en': 'Price'},
      'value': '65000.00',
    },
  ],
  'media': [
    for (var i = 1; i <= 3; i++)
      {
        'id': 'm$i',
        'thumbhash': testThumbhash,
        'variants': {
          'thumb': {
            'url': 'https://cdn.test/m$i-thumb.webp',
            'width': 200,
            'height': 150,
          },
          'card': {
            'url': 'https://cdn.test/m$i-card.webp',
            'width': 600,
            'height': 450,
          },
          'full': {
            'url': 'https://cdn.test/m$i-full.webp',
            'width': 1200,
            'height': 900,
          },
        },
      },
  ],
  'location': {'lat': 23.8069, 'lng': 90.3687},
  'area': {'bn': 'মিরপুর ১০', 'en': 'Mirpur 10'},
  'distanceMeters': 850,
  'seller': {
    'name': 'রহিম মিয়া',
    'memberSince': '2025-03-10T00:00:00.000Z',
    'badges': ['trusted', 'phone_verified'],
    'store': {
      'id': 's1',
      'slug': 'rahim-mobile',
      'name': {'bn': 'রহিম মোবাইল', 'en': 'Rahim Mobile'},
      'verified': true,
    },
    'responseHint': null,
  },
  'contact': {
    'name': 'রহিম',
    'channels': channels,
    'allowChat': true,
    'loginRequired': loginRequired,
  },
  'share': {
    'code': 'abcd2345',
    'url': 'https://mirpur.amarelaka.com/s/abcd2345',
  },
  'similar': [
    for (final card in similar ?? const <FeedPostCard>[]) postCardJson(card),
  ],
  'isMine': isMine,
  'isSaved': isSaved,
  'publishedAt': '2026-09-20T08:00:00.000Z',
  'expiresAt': '2026-10-20T08:00:00.000Z',
  'soldAt': isSold ? '2026-09-25T08:00:00.000Z' : null,
  'createdAt': '2026-09-20T08:00:00.000Z',
  'updatedAt': '2026-09-20T08:00:00.000Z',
  if (isMine)
    'stats': {
      'views': 42,
      'contacts': {'call': 3, 'whatsapp': 2, 'sms': 0, 'total': 5},
      'saves': 7,
    },
});

ApiException apiError(int status, String code, {Object? details}) =>
    ApiException(
      ApiErrorBody.fromJson({
        'statusCode': status,
        'error': code,
        'message': code,
        'details': ?details,
      }),
    );

// ---- fakes -------------------------------------------------------------------

/// Serves scripted pages; records what it was asked for.
class FakeFeedApi implements FeedApi {
  /// First page, and pages after each cursor.
  String firstPage = feedPageJson([postCardJson(postCard())]);
  final Map<String, String> pagesAfter = {};

  /// Set: every call fails like this (e.g. offline).
  AppException? failWith;
  final List<({FeedQuery query, String? cursor})> requests = [];

  @override
  Future<FeedFetch> page(
    FeedQuery query, {
    double? lat,
    double? lng,
    String? cursor,
  }) async {
    requests.add((query: query, cursor: cursor));
    if (failWith case final error?) throw error;
    final raw = cursor == null ? firstPage : pagesAfter[cursor]!;
    return (
      page: FeedPage.fromJson(jsonDecode(raw) as Map<String, dynamic>),
      rawJson: raw,
    );
  }
}

class FakeEngagementApi implements EngagementApi {
  final Map<String, PostDetail> details = {'p1': postDetail()};
  final List<String> saved = [];
  final List<String> unsaved = [];
  final List<(String, String)> contacts = [];
  final List<(String, String, String?)> reports = [];
  final List<String> views = [];
  AppException? contactError;
  AppException? saveError;

  @override
  Future<PostDetail> detail(String postId, {double? lat, double? lng}) async {
    final found = details[postId];
    if (found == null) throw apiError(404, 'POST_NOT_FOUND');
    return found;
  }

  @override
  Future<void> view(String postId) async => views.add(postId);

  @override
  Future<ContactReveal> contact(String postId, String channel) async {
    if (contactError case final error?) throw error;
    contacts.add((postId, channel));
    const message =
        'আসসালামু আলাইকুম। "আমার এলাকা" অ্যাপে আপনার বিজ্ঞাপনটি দেখলাম।';
    return ContactReveal(
      channel: channel,
      name: 'রহিম',
      phone: '+8801711111111',
      href: switch (channel) {
        'call' => 'tel:+8801711111111',
        'sms' => 'sms:+8801711111111?body=${Uri.encodeComponent(message)}',
        _ => 'https://wa.me/8801711111111?text=${Uri.encodeComponent(message)}',
      },
      message: channel == 'call' ? null : message,
    );
  }

  @override
  Future<void> report(String postId, String reasonCode, String? text) async =>
      reports.add((postId, reasonCode, text));

  @override
  Future<void> save(String postId) async {
    if (saveError case final error?) throw error;
    saved.add(postId);
  }

  @override
  Future<void> unsave(String postId) async {
    if (saveError case final error?) throw error;
    unsaved.add(postId);
  }
}

/// Records what would have opened outside the app.
class FakeExternalApps implements ExternalApps {
  FakeExternalApps({this.whatsappInstalled = true});

  bool whatsappInstalled;
  final List<Uri> opened = [];
  final List<String> shared = [];

  @override
  Future<bool> canOpen(Uri uri) async =>
      uri.scheme != 'whatsapp' || whatsappInstalled;

  @override
  Future<bool> open(Uri uri) async {
    if (!await canOpen(uri)) return false;
    opened.add(uri);
    return true;
  }

  @override
  Future<void> share(String text) async => shared.add(text);
}

class GuestAuthController extends AuthController {
  @override
  AuthSessionState build() => const AuthSessionUnauthenticated();
}

/// Photos "load" instantly as a plain colour, so goldens are deterministic
/// and no test touches the network or the disk cache.
Widget loadedPhoto(String url, Widget placeholder) =>
    ColoredBox(key: ValueKey('photo:$url'), color: const Color(0xFF8FA3B8));

// ---- the app under test -------------------------------------------------------

class FeedTestApp {
  FeedTestApp({
    required this.feed,
    required this.engagement,
    required this.apps,
    required this.db,
    required this.router,
  });

  final FakeFeedApi feed;
  final FakeEngagementApi engagement;
  final FakeExternalApps apps;
  final AppDatabase db;
  final GoRouter router;
}

/// Home (the feed), the post detail and a stand-in login screen, with fakes
/// behind them, in Bengali.
Future<FeedTestApp> pumpFeedApp(
  WidgetTester tester, {
  FakeFeedApi? feed,
  FakeEngagementApi? engagement,
  FakeExternalApps? apps,
  AppDatabase? db,
  bool signedIn = true,
  String initialLocation = RoutePaths.home,
  ThemeData? theme,
  Size physicalSize = const Size(1080, 2400),
  Widget Function(String url, Widget placeholder)? photos,
  bool settle = true,
  List<Override> overrides = const [],
  List<RouteBase> routes = const [],
}) async {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);

  final fakeFeed = feed ?? FakeFeedApi();
  final fakeEngagement = engagement ?? FakeEngagementApi();
  final fakeApps = apps ?? FakeExternalApps();
  final database = db ?? memoryDatabase();
  if (db == null) addTearDown(() => tester.runAsync(database.close));
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: RoutePaths.home,
        builder: (_, _) => const Scaffold(body: FeedScreen()),
      ),
      GoRoute(
        path: '${RoutePaths.postDetail}/:id',
        builder: (_, state) =>
            PostDetailScreen(postId: state.pathParameters['id']!),
      ),
      GoRoute(
        path: RoutePaths.login,
        builder: (_, _) => const Scaffold(body: Text('login-screen')),
      ),
      ...routes,
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        feedApiProvider.overrideWithValue(fakeFeed),
        engagementApiProvider.overrideWithValue(fakeEngagement),
        externalAppsProvider.overrideWithValue(fakeApps),
        postsApiProvider.overrideWithValue(FakePostsApi()),
        appDatabaseProvider.overrideWithValue(database),
        authControllerProvider.overrideWith(
          signedIn ? FakeAuthController.new : GuestAuthController.new,
        ),
        currentTenantConfigProvider.overrideWithValue(testTenant),
        viewerPositionProvider.overrideWith(
          (ref) async => const LocationGranted(23.8069, 90.3687),
        ),
        // What navigates from outside a screen (a tapped push) uses this router too.
        appRouterProvider.overrideWithValue(router),
        ...overrides,
      ],
      child: NetworkPhotoOverride(
        builder: photos ?? loadedPhoto,
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
  if (settle) await settleFeed(tester);
  return FeedTestApp(
    feed: fakeFeed,
    engagement: fakeEngagement,
    apps: fakeApps,
    db: database,
    router: router,
  );
}

/// Lets Drift (real async IO) and the feed's loads finish.
Future<void> settleFeed(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pumpAndSettle();
  }
}
