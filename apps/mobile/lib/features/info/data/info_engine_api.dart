import 'dart:convert';
import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/media_upload_service.dart';
import 'info_engine_models.dart';

/// The info engine over REST (apps/api/src/info-engine, ADR 065). Every list
/// is `InfoCard`s; the reporter's number of a lost & found item arrives only
/// from [contactLostFound], as a lead.
class InfoEngineApi {
  InfoEngineApi(this._dio, this._uploads);

  final Dio _dio;
  final MediaUploadService _uploads;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  static Map<String, Object> _origin(({double lat, double lng})? at) => {
    if (at != null) ...{'lat': at.lat, 'lng': at.lng},
  };

  /// One of the lists (`/info/outages`, `/info/notices`, …) with its filters.
  Future<({List<InfoCard> items, String? next})> list(
    String path, {
    ({double lat, double lng})? at,
    Map<String, String> filters = const {},
  }) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      path,
      queryParameters: {..._origin(at), ...filters},
    );
    return (items: infoCards(r.data!), next: r.data!['next'] as String?);
  });

  Future<({int reporters, int threshold, bool shown})> reportOutage(
    String utility,
    ({double lat, double lng})? at,
  ) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/info/outages/reports',
      data: {
        'utility': utility,
        if (at != null) 'location': {'lat': at.lat, 'lng': at.lng},
      },
    );
    final d = r.data!;
    return (
      reporters: (d['reporters'] as num).toInt(),
      threshold: (d['threshold'] as num).toInt(),
      shown: d['shown'] as bool,
    );
  });

  Future<NoticeDetail> notice(String id) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/info/notices/$id');
    return NoticeDetail.fromJson(r.data!);
  });

  /// A community notice (it waits for a moderator). Returns the status.
  Future<String> createNotice(Map<String, Object?> body) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/info/notices',
      data: body,
    );
    return r.data!['status'] as String;
  });

  Future<void> report(String kind, String id, String reasonCode) =>
      _call(() async {
        await _dio.post<void>(
          '/info/$kind/$id/report',
          data: {'reasonCode': reasonCode},
        );
      });

  Future<LostFoundDetail> lostFound(String id) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/info/lost-found/$id');
    return LostFoundDetail.fromJson(r.data!);
  });

  Future<String> createLostFound(Map<String, Object?> body) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/info/lost-found',
      data: body,
    );
    return r.data!['status'] as String;
  });

  Future<void> resolveLostFound(String id) => _call(() async {
    await _dio.post<void>('/info/lost-found/$id/resolve');
  });

  /// The reporter's number as a tel:/sms:/wa.me link (a lead).
  Future<String> contactLostFound(String id, String channel) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/info/lost-found/$id/contact',
      data: {'channel': channel},
    );
    return r.data!['href'] as String;
  });

  /// A photo for a lost & found report: its media id.
  Future<String> uploadPhoto(File file) async => (await _uploads.uploadAsset(
    file,
    kind: MediaKind.image,
    contentType: 'image/jpeg',
  )).id;

  Future<RouteDetail> route(String id) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/info/transport/routes/$id',
    );
    return RouteDetail.fromJson(r.data!);
  });

  Future<GovServiceDetail> govService(String slug) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/info/gov-services/$slug');
    return GovServiceDetail.fromJson(r.data!);
  });

  Future<GovVersion> govVersion(String slug, int no) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/info/gov-services/$slug/versions/$no',
    );
    return GovVersion.fromJson(r.data!);
  });

  Future<PrayerSettings> prayerSettings() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/info/prayer/settings');
    return PrayerSettings.fromJson(r.data!);
  });

  Future<bool> agriEnabled() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/info/services');
    return r.data!['agri'] as bool? ?? false;
  });
}

final infoEngineApiProvider = Provider<InfoEngineApi>(
  (ref) => InfoEngineApi(
    ref.watch(dioClientProvider),
    ref.watch(mediaUploadServiceProvider),
  ),
);

/// The area's prayer settings, kept on the phone: prayer times are
/// calculated with no network (ADR 065).
class PrayerSettingsStore {
  PrayerSettingsStore(this._api, this._prefs);

  final InfoEngineApi _api;
  final Future<SharedPreferences> Function() _prefs;

  static String _key(String tenantId) => 'prayer_settings:$tenantId';

  Future<PrayerSettings> load(String tenantId) async {
    try {
      final fresh = await _api.prayerSettings();
      await (await _prefs()).setString(
        _key(tenantId),
        jsonEncode(fresh.toJson()),
      );
      return fresh;
    } on Object {
      final kept = (await _prefs()).getString(_key(tenantId));
      if (kept == null) return PrayerSettings.fallback;
      return PrayerSettings.fromJson(jsonDecode(kept) as Map<String, dynamic>);
    }
  }
}

final prayerSettingsStoreProvider = Provider<PrayerSettingsStore>(
  (ref) => PrayerSettingsStore(
    ref.watch(infoEngineApiProvider),
    SharedPreferences.getInstance,
  ),
);
