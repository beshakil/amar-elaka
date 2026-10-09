import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import 'store_models.dart';

/// Stores (ADR 054/057): the public page and its actions, and the owner's
/// and staff's side. Failures surface as [AppException]; the screens turn
/// its code into a Bengali sentence.
abstract interface class StoreApi {
  Future<StorePageData> page(String slug, {String? category, String? cursor});

  /// Follow or unfollow; the new state and count.
  Future<({bool following, int? followerCount})> setFollowing(
    String storeId, {
    required bool follow,
  });

  /// The store's number for [channel], recorded as a lead (source store_page).
  Future<ContactReveal> contact(String storeId, String channel);

  Future<List<MyStoreSummary>> mine();
  Future<ManagedStore> create(NewStore store);
  Future<ManagedStore> manage(String storeId);
  Future<ManagedStore> update(String storeId, Map<String, dynamic> patch);
  Future<StoreHours> hours(String storeId);
  Future<StoreHours> putWeekly(String storeId, List<WeeklyRange> weekly);
  Future<void> putSpecialDays(String storeId, List<SpecialDay> days);

  /// "Closed today" on or off; the open state that follows.
  Future<String?> setClosedToday(String storeId, {required bool closed});
  Future<StaffMember> invite(String storeId, String phone, String role);
  Future<void> removeStaff(String storeId, String memberId);
  Future<ManagedStore> acceptInvitation(String storeId);
  Future<({List<StoreProduct> items, String? nextCursor})> products(
    String storeId, {
    String? cursor,
  });

  /// A product's stock (POST /posts/:id/stock).
  Future<void> setStock(String postId, String stockStatus);
}

class DioStoreApi implements StoreApi {
  DioStoreApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<Map<String, dynamic>> _json(
    Future<Response<Map<String, dynamic>>> request,
  ) async => (await request).data!;

  @override
  Future<StorePageData> page(String slug, {String? category, String? cursor}) =>
      _call(
        () async => StorePageData.fromJson(
          await _json(
            _dio.get(
              '/stores/$slug',
              queryParameters: {'category': ?category, 'cursor': ?cursor},
            ),
          ),
        ),
      );

  @override
  Future<({bool following, int? followerCount})> setFollowing(
    String storeId, {
    required bool follow,
  }) => _call(() async {
    final data = await _json(
      follow
          ? _dio.post('/stores/$storeId/follow')
          : _dio.delete('/stores/$storeId/follow'),
    );
    return (
      following: data['following'] as bool,
      followerCount: (data['followerCount'] as num?)?.toInt(),
    );
  });

  @override
  Future<ContactReveal> contact(String storeId, String channel) => _call(
    () async => ContactReveal.fromJson(
      await _json(
        _dio.post(
          '/stores/$storeId/contact',
          data: {'channel': channel, 'source': 'store_page'},
        ),
      ),
    ),
  );

  @override
  Future<List<MyStoreSummary>> mine() => _call(() async {
    final data = await _json(_dio.get('/stores/me'));
    return [
      for (final s in data['items'] as List)
        MyStoreSummary.fromJson(s as Map<String, dynamic>),
    ];
  });

  @override
  Future<ManagedStore> create(NewStore store) => _call(
    () async => ManagedStore.fromJson(
      await _json(_dio.post('/stores', data: store.toJson())),
    ),
  );

  @override
  Future<ManagedStore> manage(String storeId) => _call(
    () async =>
        ManagedStore.fromJson(await _json(_dio.get('/stores/$storeId/manage'))),
  );

  @override
  Future<ManagedStore> update(String storeId, Map<String, dynamic> patch) =>
      _call(
        () async => ManagedStore.fromJson(
          await _json(_dio.patch('/stores/$storeId', data: patch)),
        ),
      );

  @override
  Future<StoreHours> hours(String storeId) => _call(
    () async =>
        StoreHours.fromJson(await _json(_dio.get('/stores/$storeId/hours'))),
  );

  @override
  Future<StoreHours> putWeekly(String storeId, List<WeeklyRange> weekly) =>
      _call(
        () async => StoreHours.fromJson(
          await _json(
            _dio.put(
              '/stores/$storeId/hours',
              data: {
                'weekly': [for (final r in weekly) r.toJson()],
              },
            ),
          ),
        ),
      );

  @override
  Future<void> putSpecialDays(String storeId, List<SpecialDay> days) => _call(
    () => _dio.put<void>(
      '/stores/$storeId/special-days',
      data: {
        'days': [for (final d in days) d.toJson()],
      },
    ),
  );

  @override
  Future<String?> setClosedToday(String storeId, {required bool closed}) =>
      _call(() async {
        final data = await _json(
          _dio.post('/stores/$storeId/closed-today', data: {'closed': closed}),
        );
        return (data['openState'] as Map<String, dynamic>?)?['state']
            as String?;
      });

  @override
  Future<StaffMember> invite(String storeId, String phone, String role) =>
      _call(
        () async => StaffMember.fromJson(
          await _json(
            _dio.post(
              '/stores/$storeId/staff',
              data: {'phone': phone, 'role': role},
            ),
          ),
        ),
      );

  @override
  Future<void> removeStaff(String storeId, String memberId) =>
      _call(() => _dio.delete<void>('/stores/$storeId/staff/$memberId'));

  @override
  Future<ManagedStore> acceptInvitation(String storeId) => _call(
    () async => ManagedStore.fromJson(
      await _json(_dio.post('/stores/$storeId/staff/accept')),
    ),
  );

  @override
  Future<({List<StoreProduct> items, String? nextCursor})> products(
    String storeId, {
    String? cursor,
  }) => _call(() async {
    final data = await _json(
      _dio.get(
        '/stores/$storeId/products',
        queryParameters: {'cursor': ?cursor},
      ),
    );
    return (
      items: [
        for (final p in data['items'] as List)
          StoreProduct.fromJson(p as Map<String, dynamic>),
      ],
      nextCursor: data['nextCursor'] as String?,
    );
  });

  @override
  Future<void> setStock(String postId, String stockStatus) => _call(
    () => _dio.post<void>(
      '/posts/$postId/stock',
      data: {'stockStatus': stockStatus},
    ),
  );
}

final storeApiProvider = Provider<StoreApi>(
  (ref) => DioStoreApi(ref.watch(dioClientProvider)),
);
