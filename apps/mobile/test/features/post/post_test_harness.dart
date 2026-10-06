import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/design/app_theme.dart';
import 'package:amar_elaka_app/core/design/widgets/app_text_field.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/network/connectivity_provider.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/core/storage/app_database.dart';
import 'package:amar_elaka_app/core/storage/app_database_provider.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/auth/domain/auth_session_state.dart';
import 'package:amar_elaka_app/features/media_upload/application/upload_queue.dart';
import 'package:amar_elaka_app/features/post/application/current_tenant.dart';
import 'package:amar_elaka_app/features/post/data/posts_api.dart';
import 'package:amar_elaka_app/features/post/domain/post_step.dart';
import 'package:amar_elaka_app/core/map/base_map.dart';
import 'package:amar_elaka_app/features/post/presentation/editor/post_editor_screen.dart';
import 'package:amar_elaka_app/features/post/presentation/editor/post_result_screen.dart';
import 'package:amar_elaka_app/features/post/presentation/my_posts/my_posts_screen.dart';
import 'package:amar_elaka_app/features/post/presentation/post_screen.dart';
import 'package:amar_elaka_app/features/tenant_bootstrap/data/location_service.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:drift/drift.dart' show DatabaseConnection;
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';

import '../media_upload/upload_fakes.dart';

// ---- fixtures ----------------------------------------------------------------

/// A small, fully-known category: two-option chips, free text, a price.
final phoneCategory = CatalogCategory.fromJson({
  'id': '0191e3a0-0000-7000-8000-00000000c001',
  'parentId': null,
  'slug': 'mobile-phones',
  'kind': 'marketplace',
  'name': {'bn': 'মোবাইল ফোন', 'en': 'Mobile phones'},
  'iconKey': 'smartphone',
  'postExpiryDays': 30,
  'requiresApproval': false,
  'fieldSchema': {
    'jsonSchema': {
      'type': 'object',
      'properties': {
        'condition': {
          'x-field-type': 'select',
          'type': 'string',
          'enum': ['new', 'used'],
        },
        'brand': {'x-field-type': 'text', 'type': 'string', 'maxLength': 60},
        'price': {
          'x-field-type': 'money',
          'type': 'string',
          'x-money-min': '100.00',
          'x-money-max': '10000000.00',
        },
      },
      'required': ['condition', 'price'],
    },
    'uiSchema': {
      'order': ['condition', 'brand', 'price'],
      'card': ['condition', 'brand'],
      'labels': {
        'condition': {'bn': 'অবস্থা', 'en': 'Condition'},
        'brand': {'bn': 'ব্র্যান্ড', 'en': 'Brand'},
        'price': {'bn': 'দাম', 'en': 'Price'},
      },
      'options': {
        'condition': {
          'new': {'bn': 'নতুন', 'en': 'New'},
          'used': {'bn': 'ব্যবহৃত', 'en': 'Used'},
        },
      },
    },
    'filterableFields': ['condition', 'price'],
    'searchableFields': ['brand'],
  },
});

final rentCategory = CatalogCategory.fromJson({
  'id': '0191e3a0-0000-7000-8000-00000000c002',
  'parentId': null,
  'slug': 'to-let',
  'kind': 'marketplace',
  'name': {'bn': 'টু-লেট / বাসা ভাড়া', 'en': 'To-Let / House Rent'},
  'iconKey': 'key-round',
  'postExpiryDays': 30,
  'requiresApproval': true,
  'fieldSchema': phoneCategory.fieldSchema,
});

/// A module tile: listed by GET /categories, but nothing to post there.
final bloodTile = CatalogCategory.fromJson({
  'id': '0191e3a0-0000-7000-8000-00000000c003',
  'parentId': null,
  'slug': 'blood-donation',
  'kind': 'module',
  'name': {'bn': 'রক্তদান', 'en': 'Blood donation'},
  'iconKey': 'droplet',
  'postExpiryDays': null,
  'requiresApproval': false,
  'fieldSchema': null,
});

const testMe = MeResult(
  userId: 'u1',
  phone: '+8801712345678',
  email: null,
  displayName: 'রহিম উদ্দিন',
  avatarStorageKey: null,
  tenantId: 't1',
  memberId: 'm1',
  role: 'member',
);

final testTenant = TenantConfig.fromJson({
  'id': 't1',
  'slug': 'mirpur',
  'nameBn': 'মিরপুর',
  'nameEn': 'Mirpur',
  'defaultLocale': 'bn',
  'mapCenter': {'lat': 23.8069, 'lng': 90.3687},
  'radiusKm': 5,
  'branding': {'logoStorageKey': null},
  'featureFlags': <String, dynamic>{},
  'enabledCategories': <dynamic>[],
  'emergencyNumbers': <dynamic>[],
  'support': {'phoneE164': null, 'email': null, 'whatsappE164': null},
  'moderation': {'typicalReviewHours': 12},
});

PostView fakePost({
  String id = 'p1',
  String status = 'live',
  String title = 'আইফোন ১৩ বিক্রি',
  Map<String, dynamic> fields = const {
    'condition': 'used',
    'price': '65000.00',
  },
  bool hidden = false,
  String? moderationReason,
  String? moderationNote,
  String? soldPrice,
}) => PostView.fromJson({
  'id': id,
  'tenantId': 't1',
  'status': status,
  'categoryId': phoneCategory.id,
  'fieldSchemaId': 's1',
  'title': title,
  'description': 'বক্স সহ, কোনো দাগ নেই',
  'fields': fields,
  'price': fields['price'],
  'location': {'lat': 23.8069, 'lng': 90.3687},
  'outsideBoundary': false,
  'media': <dynamic>[],
  'showPhone': true,
  'allowChat': true,
  'showWhatsapp': false,
  'contact': {
    'name': 'রহিম উদ্দিন',
    'phone': '+8801712345678',
    'whatsapp': false,
  },
  'isSold': status == 'sold',
  'soldPrice': soldPrice,
  'publishedAt': '2026-09-20T10:00:00Z',
  'expiresAt': '2026-10-20T10:00:00Z',
  'createdAt': '2026-09-20T10:00:00Z',
  'updatedAt': '2026-09-20T10:00:00Z',
  'isMine': true,
  'hiddenByOwner': hidden,
  'moderationReason': moderationReason,
  'moderationNote': moderationNote,
});

ApiException apiError(String code, {int status = 409, Object? details}) =>
    ApiException(
      ApiErrorBody(
        statusCode: status,
        error: code,
        message: 'x',
        details: details,
      ),
    );

// ---- fakes -------------------------------------------------------------------

/// The API, in memory, recording what the app sent.
class FakePostsApi implements PostsApi {
  List<CatalogCategory> categoryList = [phoneCategory, rentCategory, bloodTile];
  Object? categoriesError;

  /// What POST /posts answers with: the status the server decided.
  String createStatus = 'live';
  final List<AppException> createErrors = [];
  final List<({Map<String, Object?> body, String key})> created = [];
  final List<({String id, Map<String, Object?> body})> updated = [];
  final List<String> calls = [];

  bool outsideBoundary = false;
  bool needsReview = false;
  String? addressLabelBn = 'মিরপুর ১০, ঢাকা';
  List<GeocodeResult> searchResults = [];

  List<PostView> posts = [];
  final Map<String, AppException> actionErrors = {};

  @override
  Future<List<CatalogCategory>> categories() async {
    if (categoriesError case final Object error) throw error;
    return categoryList;
  }

  @override
  Future<PostView> create(
    Map<String, Object?> body, {
    required String idempotencyKey,
  }) async {
    if (createErrors.isNotEmpty) throw createErrors.removeAt(0);
    created.add((body: body, key: idempotencyKey));
    final post = fakePost(
      id: 'new-${created.length}',
      status: createStatus,
      title: body['title']! as String,
      fields: Map<String, dynamic>.from(body['fields']! as Map),
    );
    posts.add(post);
    return post;
  }

  @override
  Future<PostView> update(String id, Map<String, Object?> body) async {
    updated.add((id: id, body: body));
    final post = posts.firstWhere(
      (p) => p.id == id,
      orElse: () => fakePost(id: id),
    );
    return fakePost(
      id: id,
      status: post.status,
      title: body['title'] as String? ?? post.title,
    );
  }

  @override
  Future<PostView> submit(String id) async {
    calls.add('submit:$id');
    return fakePost(id: id, status: 'pending');
  }

  @override
  Future<PostView> get(String id) async => posts.firstWhere((p) => p.id == id);

  @override
  Future<MyPostsPage> mine({
    List<String>? statuses,
    bool? hidden,
    String? cursor,
  }) async {
    final items = [
      for (final post in posts)
        if ((statuses == null || statuses.contains(post.status)) &&
            (hidden == null || (post.hiddenByOwner ?? false) == hidden))
          post,
    ];
    return MyPostsPage(items: items, nextCursor: null);
  }

  @override
  Future<MyPostCounts> counts() async {
    int count(bool Function(PostView) test) => posts.where(test).length;
    bool shown(PostView p) => !(p.hiddenByOwner ?? false);
    return MyPostCounts(
      draft: count((p) => shown(p) && p.status == 'draft'),
      pending: count((p) => shown(p) && p.status == 'pending'),
      live: count((p) => shown(p) && p.status == 'live'),
      rejected: count((p) => shown(p) && p.status == 'rejected'),
      sold: count((p) => shown(p) && p.status == 'sold'),
      expired: count((p) => shown(p) && p.status == 'expired'),
      removed: count((p) => shown(p) && p.status == 'removed'),
      hidden: count((p) => !shown(p)),
    );
  }

  Future<PostView> _act(
    String name,
    String id,
    PostView Function(PostView) change,
  ) async {
    calls.add('$name:$id');
    if (actionErrors[name] case final error?) throw error;
    final index = posts.indexWhere((p) => p.id == id);
    final changed = change(posts[index]);
    posts[index] = changed;
    return changed;
  }

  PostView _with(
    PostView p, {
    String? status,
    bool? hidden,
    String? soldPrice,
  }) => fakePost(
    id: p.id,
    status: status ?? p.status,
    title: p.title,
    fields: p.fields,
    hidden: hidden ?? (p.hiddenByOwner ?? false),
    soldPrice: soldPrice ?? p.soldPrice,
    moderationReason: p.moderationReason,
    moderationNote: p.moderationNote,
  );

  @override
  Future<PostView> markSold(String id, {String? soldPrice}) => _act(
    'sold${soldPrice == null ? '' : '($soldPrice)'}',
    id,
    (p) => _with(p, status: 'sold', soldPrice: soldPrice),
  );

  @override
  Future<PostView> repost(String id) =>
      _act('repost', id, (p) => _with(p, status: 'live'));

  @override
  Future<PostView> setHidden(String id, {required bool hidden}) =>
      _act(hidden ? 'hide' : 'unhide', id, (p) => _with(p, hidden: hidden));

  @override
  Future<void> delete(String id) async {
    calls.add('delete:$id');
    posts.removeWhere((p) => p.id == id);
  }

  @override
  Future<PostOwnership> ownership(double lat, double lng) async =>
      PostOwnership(
        tenantId: 't1',
        resolution: outsideBoundary ? 'within_buffer' : 'inside_boundary',
        outsideBoundary: outsideBoundary,
        needsReview: needsReview,
      );

  /// The `purpose` of the last reverse geocode (decides the Barikoi fields).
  String? lastReversePurpose;

  @override
  Future<ReverseGeocode> reverseGeocode(
    double lat,
    double lng, {
    String purpose = 'post_location',
  }) async {
    lastReversePurpose = purpose;
    return ReverseGeocode(
      location: LatLng(lat: lat, lng: lng),
      purpose: purpose,
      address: addressLabelBn == null
          ? null
          : GeoAddress(
              label: 'Mirpur 10, Dhaka',
              labelBn: addressLabelBn,
              area: 'Mirpur',
              city: 'Dhaka',
            ),
      areas: const [],
      degraded: false,
    );
  }

  @override
  Future<GeocodeResponse> autocomplete(
    String query, {
    double? lat,
    double? lng,
  }) async =>
      GeocodeResponse(query: query, results: searchResults, degraded: false);
}

class FakeAuthController extends AuthController {
  @override
  AuthSessionState build() => const AuthSessionAuthenticated(testMe);
}

class FakeLocationService extends LocationService {
  FakeLocationService([this.result = const LocationGranted(23.8069, 90.3687)]);

  LocationResult result;

  @override
  Future<LocationResult> requestAndGetPosition() async => result;
}

/// Picks prepared files, as if chosen from the gallery.
class FakeImagePicker extends ImagePicker {
  FakeImagePicker(this.files);

  final List<String> files;

  @override
  Future<List<XFile>> pickMultiImage({
    double? maxWidth,
    double? maxHeight,
    int? imageQuality,
    int? limit,
    bool requestFullMetadata = true,
  }) async => [for (final path in files) XFile(path)];

  @override
  Future<LostDataResponse> retrieveLostData() async => LostDataResponse.empty();
}

// ---- the app under test -------------------------------------------------------

class PostTestApp {
  PostTestApp({
    required this.api,
    required this.db,
    required this.transport,
    required this.router,
  });

  final FakePostsApi api;
  final AppDatabase db;
  final FakeTransport transport;
  final GoRouter router;
}

/// The post routes with fakes behind them, in Bengali. The database is
/// in-memory and outlives a single pump when passed in (app-kill tests).
Future<PostTestApp> pumpPostApp(
  WidgetTester tester, {
  FakePostsApi? api,
  AppDatabase? db,
  String initialLocation = RoutePaths.post,
  LocationService? location,
  ImagePicker? picker,
  bool online = true,
  ThemeData? theme,
  Directory? uploadDir,
  Size physicalSize = const Size(1080, 2400),
}) async {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = 2.5;
  addTearDown(tester.view.reset);

  final fakeApi = api ?? FakePostsApi();
  final database = db ?? memoryDatabase();
  // A database passed in belongs to the test (it outlives a pump on purpose).
  if (db == null) addTearDown(() => tester.runAsync(database.close));
  final transport = FakeTransport();
  final dir =
      uploadDir ??
      await tester.runAsync(() => Directory.systemTemp.createTemp('post_test'));
  final store = MemoryStore(dir!);
  final router = GoRouter(
    initialLocation: initialLocation,
    routes: [
      GoRoute(
        path: RoutePaths.post,
        builder: (_, _) => const Scaffold(body: PostScreen()),
      ),
      GoRoute(
        path: '${RoutePaths.postEditor}/:draftId',
        builder: (_, state) => PostEditorScreen(
          draftId: state.pathParameters['draftId']!,
          picker: picker,
        ),
      ),
      GoRoute(
        path: RoutePaths.postResult,
        builder: (_, state) =>
            PostResultScreen(args: state.extra! as PostResultArgs),
      ),
      GoRoute(
        path: RoutePaths.myPosts,
        builder: (_, _) => const MyPostsScreen(),
      ),
    ],
  );
  addTearDown(router.dispose);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        postsApiProvider.overrideWithValue(fakeApi),
        appDatabaseProvider.overrideWithValue(database),
        authControllerProvider.overrideWith(FakeAuthController.new),
        currentTenantConfigProvider.overrideWithValue(testTenant),
        locationServiceProvider.overrideWithValue(
          location ?? FakeLocationService(),
        ),
        baseMapEnabledProvider.overrideWithValue(false),
        isOnlineProvider.overrideWith((ref) => Stream.value(online)),
        uploadQueueProvider.overrideWith((ref, queueId) {
          final queue = UploadQueue(
            queueId: queueId,
            compressor: FakeCompressor(),
            transport: transport,
            store: store,
            retryDelays: const [],
          );
          ref.onDispose(queue.dispose);
          queue.restore();
          return queue;
        }),
      ],
      child: MaterialApp.router(
        debugShowCheckedModeBanner: false,
        theme: theme ?? AppTheme.light(),
        locale: const Locale('bn'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        routerConfig: router,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return PostTestApp(
    api: fakeApi,
    db: database,
    transport: transport,
    router: router,
  );
}

/// A fresh in-memory database; streams close synchronously so widget tests
/// don't end with timers pending.
AppDatabase memoryDatabase() => AppDatabase.forTesting(
  DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true),
);

/// Lets the editor's debounced autosave and the database settle.
Future<void> settleSaves(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 500));
  await tester.runAsync(
    () => Future<void>.delayed(const Duration(milliseconds: 50)),
  );
  await tester.pumpAndSettle();
}

/// From the Post tab to [step] of a new phone post, filling what each step needs.
Future<void> walkTo(
  WidgetTester tester,
  PostStep step, {
  String title = 'আইফোন ১৩ বিক্রি',
}) async {
  await tester.tap(find.byKey(const ValueKey('post-new')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('category-mobile-phones')));
  await settleSaves(tester);
  if (step == PostStep.details) return;
  await tester.enterText(
    find.descendant(
      of: find.byKey(const ValueKey('post-title')),
      matching: find.byType(TextField),
    ),
    title,
  );
  await tester.tap(find.text('ব্যবহৃত'));
  await tester.enterText(labelledField('দাম'), '৬৫০০০');
  await next(tester);
  if (step == PostStep.photos) return;
  await next(tester);
  await settleSaves(tester);
  if (step == PostStep.location) return;
  await next(tester);
  if (step == PostStep.contact) return;
  await next(tester);
}

Future<void> next(WidgetTester tester) async {
  await tester.tap(find.byKey(const ValueKey('editor-next')));
  await settleSaves(tester);
}

/// A form field's label as drawn (AppFieldLabel: the label, plus " *" when required).
Finder fieldLabel(String label) =>
    find.byWidgetPredicate((w) => w is AppFieldLabel && w.label == label);

/// The text field labelled [label].
Finder labelledField(String label) => find.byWidgetPredicate(
  (w) =>
      w is TextField &&
      w.decoration?.label is AppFieldLabel &&
      (w.decoration!.label! as AppFieldLabel).label == label,
);

/// Completes when [condition] is true, polling the widget tree.
Future<void> pumpUntil(
  WidgetTester tester,
  bool Function() condition, {
  int maxPumps = 100,
}) async {
  for (var i = 0; i < maxPumps && !condition(); i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(condition(), isTrue, reason: 'condition not reached');
}

/// For tests that need a real async gap (file IO, drift).
Future<T> realAsync<T>(WidgetTester tester, Future<T> Function() work) async =>
    (await tester.runAsync(work)) as T;
