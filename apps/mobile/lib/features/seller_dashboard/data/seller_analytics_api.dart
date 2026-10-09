import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';

class ContactCounts {
  const ContactCounts({
    required this.total,
    required this.call,
    required this.whatsapp,
    required this.sms,
    required this.chat,
  });

  factory ContactCounts.fromJson(Map<String, dynamic> json) => ContactCounts(
    total: (json['total'] as num).toInt(),
    call: (json['call'] as num).toInt(),
    whatsapp: (json['whatsapp'] as num).toInt(),
    sms: (json['sms'] as num).toInt(),
    chat: (json['chat'] as num).toInt(),
  );

  final int total;
  final int call;
  final int whatsapp;
  final int sms;
  final int chat;
}

class TopPost {
  const TopPost({
    required this.postId,
    required this.title,
    required this.views,
    required this.contacts,
  });

  final String postId;
  final String title;
  final int views;
  final int contacts;
}

/// GET /stores/:id/analytics (ADR 055): what the dashboard shows.
class SellerAnalytics {
  const SellerAnalytics({
    required this.days,
    required this.available,
    required this.summaryBn,
    required this.summaryEn,
    required this.views,
    required this.uniqueViewers,
    required this.contacts,
    required this.saves,
    required this.trendViews,
    required this.trendContacts,
    required this.trendSaves,
    required this.daily,
    required this.topPosts,
  });

  factory SellerAnalytics.fromJson(Map<String, dynamic> json) {
    final period = json['period'] as Map<String, dynamic>;
    final summary = json['summary'] as Map<String, dynamic>;
    final totals = json['totals'] as Map<String, dynamic>;
    final trend = json['trend'] as Map<String, dynamic>;
    double? pct(Object? v) => (v as num?)?.toDouble();
    return SellerAnalytics(
      days: (period['days'] as num).toInt(),
      available: [
        for (final d in period['available'] as List) (d as num).toInt(),
      ],
      summaryBn: summary['bn'] as String,
      summaryEn: summary['en'] as String,
      views: (totals['views'] as num).toInt(),
      uniqueViewers: (totals['uniqueViewers'] as num).toInt(),
      contacts: ContactCounts.fromJson(
        totals['contacts'] as Map<String, dynamic>,
      ),
      saves: (totals['saves'] as num).toInt(),
      trendViews: pct(trend['views']),
      trendContacts: pct(trend['contacts']),
      trendSaves: pct(trend['saves']),
      daily: [
        for (final d in json['daily'] as List)
          (
            date: (d as Map<String, dynamic>)['date'] as String,
            views: (d['views'] as num).toInt(),
            contacts: (d['contacts'] as num).toInt(),
          ),
      ],
      topPosts: [
        for (final p in json['topPosts'] as List)
          TopPost(
            postId: (p as Map<String, dynamic>)['postId'] as String,
            title: p['title'] as String,
            views: ((p['metrics'] as Map<String, dynamic>)['views'] as num)
                .toInt(),
            contacts:
                (((p['metrics'] as Map<String, dynamic>)['contacts']
                            as Map<String, dynamic>)['total']
                        as num)
                    .toInt(),
          ),
      ],
    );
  }

  final int days;
  final List<int> available;
  final String summaryBn;
  final String summaryEn;
  final int views;
  final int uniqueViewers;
  final ContactCounts contacts;
  final int saves;

  /// Percent change against the previous period; null = nothing to compare.
  final double? trendViews;
  final double? trendContacts;
  final double? trendSaves;
  final List<({String date, int views, int contacts})> daily;
  final List<TopPost> topPosts;
}

abstract interface class SellerAnalyticsApi {
  Future<SellerAnalytics> store(String storeId, {int? days});
}

class DioSellerAnalyticsApi implements SellerAnalyticsApi {
  DioSellerAnalyticsApi(this._dio);

  final Dio _dio;

  @override
  Future<SellerAnalytics> store(String storeId, {int? days}) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/stores/$storeId/analytics',
        queryParameters: {if (days != null) 'period': '${days}d'},
      );
      return SellerAnalytics.fromJson(response.data!);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }
}

final sellerAnalyticsApiProvider = Provider<SellerAnalyticsApi>(
  (ref) => DioSellerAnalyticsApi(ref.watch(dioClientProvider)),
);

/// (storeId, days — null = the API's default period).
final sellerAnalyticsProvider = FutureProvider.autoDispose
    .family<SellerAnalytics, ({String storeId, int? days})>(
      (ref, key) => ref
          .watch(sellerAnalyticsApiProvider)
          .store(key.storeId, days: key.days),
    );
