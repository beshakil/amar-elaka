import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/features/seller_dashboard/data/seller_analytics_api.dart';
import 'package:amar_elaka_app/features/store/data/store_api.dart';
import 'package:amar_elaka_app/features/store/data/store_models.dart';

import '../feed/feed_test_harness.dart';
import '../post/goldens/golden_fonts.dart';

/// A store page as the API sends it, Bengali and conjunct-heavy.
StorePageData storePage({List<FeedPostCard>? posts, bool following = false}) =>
    StorePageData.fromJson({
      'id': 's1',
      'slug': 'rahim-electronics',
      'url': 'https://mirpur.amarelaka.com/store/rahim-electronics',
      'name': {
        'bn': 'রহিম ইলেকট্রনিক্স ও স্মার্টফোন',
        'en': 'Rahim Electronics',
      },
      'description':
          'মিরপুর ১০-এর পুরোনো মোবাইল ও আনুষাঙ্গিকের দোকান — ক্যাশ অন ডেলিভারি।',
      'addressText': 'দোকান ১২, মিরপুর ১০ গোলচত্বর',
      'area': {'bn': 'মিরপুর ১০', 'en': 'Mirpur 10'},
      'mapPin': {'lat': 23.8069, 'lng': 90.3687, 'placeId': null},
      'logo': null,
      'cover': {
        'url': 'https://cdn.test/s1-cover.webp',
        'thumbhash': testThumbhash,
      },
      'isVerified': true,
      'isFollowing': following,
      'followerCount': 1240,
      'stats': {
        'followers': 1240,
        'livePosts': 3,
        'memberSince': '2026-01-15T00:00:00.000Z',
      },
      'contactChannels': ['call', 'whatsapp', 'sms'],
      'hours': {
        'weekly': [
          {
            'day': 6,
            'opens': '09:00',
            'closes': '13:00',
            'closesNextDay': false,
          },
          {
            'day': 6,
            'opens': '15:00',
            'closes': '21:00',
            'closesNextDay': false,
          },
        ],
        'specialDays': <Object>[],
        'closedUntil': null,
        'openState': {'state': 'open', 'changesAt': null},
      },
      'catalogCategories': [
        {
          'slug': 'mobile-phones',
          'name': {'bn': 'মোবাইল ফোন', 'en': 'Phones'},
          'count': 2,
        },
        {
          'slug': 'accessories',
          'name': {'bn': 'আনুষাঙ্গিক', 'en': 'Accessories'},
          'count': 1,
        },
      ],
      'posts': <Object>[],
      'nextCursor': null,
    }).copyWith(
      posts:
          posts ??
          [
            postCard(
              id: 'p1',
              title: ConjunctText.brand,
              badges: const ['verified_store'],
            ),
            postCard(
              id: 'p2',
              title: 'স্যামসাং গ্যালাক্সি A54',
              price: '32500.00',
              badges: const ['out_of_stock'],
            ),
            postCard(
              id: 'p3',
              title: 'চার্জার ও কভার',
              price: '450.00',
              badges: const ['on_order'],
              withCover: false,
            ),
          ],
    );

class FakeStoreApi implements StoreApi {
  FakeStoreApi(this.pageData);

  StorePageData pageData;
  final followCalls = <bool>[];

  @override
  Future<StorePageData> page(
    String slug, {
    String? category,
    String? cursor,
  }) async => pageData;

  @override
  Future<({bool following, int? followerCount})> setFollowing(
    String storeId, {
    required bool follow,
  }) async {
    followCalls.add(follow);
    return (
      following: follow,
      followerCount: pageData.followerCount + (follow ? 1 : 0),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError(invocation.memberName.toString());
}

SellerAnalytics analytics() => SellerAnalytics.fromJson({
  'period': {
    'days': 30,
    'available': [7, 30, 90],
  },
  'summary': {
    'bn': 'গত ৩০ দিনে ১,২৪০ জন আপনার পোস্ট দেখেছেন, ৪৭ জন যোগাযোগ করেছেন।',
    'en':
        'In the last 30 days, 1,240 people saw your posts and 47 contacted you.',
  },
  'totals': {
    'views': 1612,
    'uniqueViewers': 1240,
    'contacts': {'total': 47, 'call': 21, 'whatsapp': 19, 'sms': 4, 'chat': 3},
    'saves': 36,
  },
  'trend': {'views': 23.6, 'contacts': -8.0, 'saves': null},
  'daily': [
    for (var i = 0; i < 30; i++)
      {
        'date': '2026-09-${(i + 1).toString().padLeft(2, '0')}',
        'views': 30 + (i * 37 % 41),
        'contacts': 1 + (i * 7 % 4),
      },
  ],
  'topPosts': [
    {
      'postId': 'p1',
      'title': ConjunctText.brand,
      'metrics': {
        'views': 412,
        'contacts': {'total': 15},
      },
    },
    {
      'postId': 'p2',
      'title': 'স্যামসাং গ্যালাক্সি A54',
      'metrics': {
        'views': 305,
        'contacts': {'total': 9},
      },
    },
  ],
});

class FakeSellerAnalyticsApi implements SellerAnalyticsApi {
  @override
  Future<SellerAnalytics> store(String storeId, {int? days}) async =>
      analytics();
}
