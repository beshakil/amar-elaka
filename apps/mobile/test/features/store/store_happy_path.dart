import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/routing/route_paths.dart';
import 'package:amar_elaka_app/features/my_store/presentation/create_store_screen.dart';
import 'package:amar_elaka_app/features/my_store/presentation/my_store_screen.dart';
import 'package:amar_elaka_app/features/store/data/store_api.dart';
import 'package:amar_elaka_app/features/store/data/store_models.dart';
import 'package:amar_elaka_app/features/store/presentation/store_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../post/post_test_harness.dart';

final _shopCategory = CatalogCategory.fromJson({
  'id': '0191e3a0-0000-7000-8000-00000000c0aa',
  'parentId': null,
  'slug': 'local-shop-directory',
  'kind': 'place',
  'name': {'bn': 'দোকান', 'en': 'Shop'},
  'iconKey': null,
  'postExpiryDays': null,
  'requiresApproval': false,
  'fieldSchema': null,
});

/// The store side of the API, kept in memory: the store the wizard opens,
/// and its page built from the posts the seller created as that store.
class InMemoryStoreApi implements StoreApi {
  InMemoryStoreApi(this.posts);

  final FakePostsApi posts;
  final created = <NewStore>[];

  static const id = 's-new';
  static const slug = 'rahim-store';

  Map<String, dynamic> _view() => {
    'id': id,
    'slug': slug,
    'catalogUrl': 'https://mirpur.amarelaka.com/store/$slug/catalog',
    'name': {'bn': created.last.nameBn, 'en': null},
    'status': 'active',
    'myRole': 'owner',
    'staff': <Object>[],
    'limits': {'staff': 3, 'catalog': 50},
  };

  @override
  Future<ManagedStore> create(NewStore store) async {
    created.add(store);
    return ManagedStore.fromJson(_view());
  }

  @override
  Future<List<MyStoreSummary>> mine() async => [
    if (created.isNotEmpty)
      MyStoreSummary.fromJson({
        'id': id,
        'slug': slug,
        'name': {'bn': created.last.nameBn, 'en': null},
        'status': 'active',
        'role': 'owner',
        'accepted': true,
      }),
  ];

  @override
  Future<StoreHours> hours(String storeId) async =>
      StoreHours.fromJson(const {});

  @override
  Future<StorePageData> page(
    String slug, {
    String? category,
    String? cursor,
  }) async {
    final products = [
      for (final (i, post) in posts.created.indexed)
        if (post.body['storeId'] == id)
          FeedPostCard.fromJson({
            'kind': 'post',
            'id': 'new-${i + 1}',
            'tenantId': 't1',
            'title': post.body['title'],
            'price': (post.body['fields'] as Map?)?['price'],
            'cover': null,
            'distanceMeters': null,
            'area': null,
            'badges': <String>[],
            'createdAt': '2026-10-09T00:00:00.000Z',
            'isSaved': false,
          }),
    ];
    return StorePageData.fromJson({
      'id': id,
      'slug': InMemoryStoreApi.slug,
      'url': 'https://mirpur.amarelaka.com/store/$slug',
      'name': {'bn': created.last.nameBn, 'en': null},
      'isFollowing': false,
      'followerCount': 0,
      'stats': {'livePosts': products.length},
      'contactChannels': ['call'],
      'catalogCategories': <Object>[],
      'posts': <Object>[],
    }).copyWith(posts: products);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

/// A seller opens a store and puts three products in it, then sees them on
/// the store's page: My store → wizard → Post ×3 "as the store" → store page.
/// Run as a widget test in CI (test/features/store/store_happy_path_test.dart)
/// and on a device (integration_test/store_happy_path_test.dart).
Future<void> runStoreHappyPath(WidgetTester tester) async {
  final dir = (await tester.runAsync(
    () => Directory.systemTemp.createTemp('store_path'),
  ))!;
  addTearDown(() => dir.delete(recursive: true));
  final photo = (await tester.runAsync(
    () => File('${dir.path}/item.jpg').writeAsBytes(List.filled(4000, 7)),
  ))!;
  final postsApi = FakePostsApi();
  final stores = InMemoryStoreApi(postsApi);
  final app = await pumpPostApp(
    tester,
    api: postsApi,
    picker: FakeImagePicker([photo.path]),
    uploadDir: dir,
    initialLocation: RoutePaths.myStore,
    overrides: [
      storeApiProvider.overrideWithValue(stores),
      storeCategoriesProvider.overrideWith((ref) async => [_shopCategory]),
    ],
    routes: [
      GoRoute(
        path: RoutePaths.myStore,
        builder: (_, _) => const MyStoreScreen(),
        routes: [
          GoRoute(path: 'new', builder: (_, _) => const CreateStoreScreen()),
        ],
      ),
      GoRoute(
        path: '${RoutePaths.store}/:slug',
        builder: (_, state) => StoreScreen(slug: state.pathParameters['slug']!),
      ),
    ],
  );

  // No store yet → open one.
  expect(find.byKey(const ValueKey('my-store-none')), findsOneWidget);
  await tester.tap(find.text('দোকান খুলুন'));
  await tester.pumpAndSettle();

  Future<void> wizardNext() async {
    await tester.tap(find.byKey(const ValueKey('store-wizard-next')));
    await tester.pumpAndSettle();
  }

  await tester.enterText(
    find.byKey(const ValueKey('store-name-bn')),
    'রহিম স্টোর',
  );
  await wizardNext();
  await tester.tap(
    find.byKey(const ValueKey('store-category-local-shop-directory')),
  );
  await tester.pumpAndSettle();
  await wizardNext();
  await tester.tap(find.byKey(const ValueKey('store-pick-location')));
  await settleSaves(tester);
  await tester.tap(find.byKey(const ValueKey('location-confirm')));
  await tester.pumpAndSettle();
  await wizardNext();
  await tester.enterText(
    find.byKey(const ValueKey('store-phone')),
    '০১৭১২৩৪৫৬৭৮',
  );
  await wizardNext();
  await wizardNext(); // photos are optional: open the store
  expect(stores.created.single.nameBn, 'রহিম স্টোর');
  expect(stores.created.single.phone, '+8801712345678');
  expect(stores.created.single.categoryId, _shopCategory.id);
  expect(
    find.byKey(const ValueKey('my-store-${InMemoryStoreApi.id}')),
    findsOneWidget,
  );

  // Three products, each posted as the store.
  final titles = ['চাল ৫০ কেজি', 'মসুর ডাল ১ কেজি', 'সয়াবিন তেল ৫ লিটার'];
  for (final (i, title) in titles.indexed) {
    app.router.go(RoutePaths.post);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('post-new')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('category-mobile-phones')));
    await settleSaves(tester);
    await tester.enterText(
      find.descendant(
        of: find.byKey(const ValueKey('post-title')),
        matching: find.byType(TextField),
      ),
      title,
    );
    await tester.tap(find.text('নতুন'));
    await tester.enterText(labelledField('ব্র্যান্ড'), 'দেশি');
    await tester.enterText(labelledField('দাম'), '${(i + 1) * 100}');
    await next(tester);
    await tester.tap(find.byIcon(Icons.add_a_photo_outlined));
    await tester.pumpAndSettle();
    await tester.tap(find.text('গ্যালারি থেকে বেছে নিন'));
    await pumpUntil(tester, () => app.transport.confirmed.length == i + 1);
    await next(tester);
    await settleSaves(tester);
    await next(tester);
    await tester.tap(
      find.byKey(const ValueKey('post-as-${InMemoryStoreApi.slug}')),
    );
    await tester.pumpAndSettle();
    await next(tester);
    await tester.tap(find.byKey(const ValueKey('editor-next')));
    // Real file IO (the sent photo's file is cleaned up): let it run.
    await pumpUntil(
      tester,
      () => find.text('আপনার পোস্ট এখন লাইভ!').evaluate().isNotEmpty,
    );
    await tester.pumpAndSettle();
    expect(postsApi.created, hasLength(i + 1));
  }
  expect(
    postsApi.created.map((p) => p.body['storeId']),
    everyElement(InMemoryStoreApi.id),
  );

  // The store's page shows all three.
  app.router.go(RoutePaths.storeFor(InMemoryStoreApi.slug));
  await tester.pumpAndSettle();
  expect(find.text('রহিম স্টোর'), findsWidgets);
  for (final title in titles) {
    await tester.scrollUntilVisible(
      find.text(title),
      200,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text(title), findsOneWidget);
  }
}
