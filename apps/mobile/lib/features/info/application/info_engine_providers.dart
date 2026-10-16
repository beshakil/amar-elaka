import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../feed/application/feed_controller.dart';
import '../../post/application/current_tenant.dart';
import '../../tenant_bootstrap/data/location_service.dart';
import '../data/info_engine_api.dart';
import '../data/info_engine_models.dart';

/// The viewer's point for a radius list — only if location is already
/// allowed (no prompt for browsing); null = the area's centre (the API's
/// fallback).
final infoOriginProvider =
    FutureProvider.autoDispose<({double lat, double lng})?>((ref) async {
      final granted = await ref.watch(viewerPositionProvider.future);
      return switch (granted) {
        LocationGranted(:final latitude, :final longitude) => (
          lat: latitude,
          lng: longitude,
        ),
        _ => null,
      };
    });

/// One list of the engine: its path and its filters (`kind=lost`, `mode=bus`…).
typedef InfoListKey = ({String path, String query});

InfoListKey infoList(String path, [Map<String, String> filters = const {}]) => (
  path: path,
  query: Uri(queryParameters: filters.isEmpty ? null : filters).query,
);

final infoListProvider = FutureProvider.autoDispose
    .family<List<InfoCard>, InfoListKey>((ref, key) async {
      final origin = await ref.watch(infoOriginProvider.future);
      final page = await ref
          .watch(infoEngineApiProvider)
          .list(key.path, at: origin, filters: Uri.splitQueryString(key.query));
      return page.items;
    });

final noticeDetailProvider = FutureProvider.autoDispose
    .family<NoticeDetail, String>(
      (ref, id) => ref.watch(infoEngineApiProvider).notice(id),
    );

final lostFoundDetailProvider = FutureProvider.autoDispose
    .family<LostFoundDetail, String>(
      (ref, id) => ref.watch(infoEngineApiProvider).lostFound(id),
    );

final routeDetailProvider = FutureProvider.autoDispose
    .family<RouteDetail, String>(
      (ref, id) => ref.watch(infoEngineApiProvider).route(id),
    );

final govDetailProvider = FutureProvider.autoDispose
    .family<GovServiceDetail, String>(
      (ref, slug) => ref.watch(infoEngineApiProvider).govService(slug),
    );

final govVersionProvider = FutureProvider.autoDispose
    .family<GovVersion, ({String slug, int no})>(
      (ref, k) => ref.watch(infoEngineApiProvider).govVersion(k.slug, k.no),
    );

/// Kept on the phone: prayer times work with no network.
final prayerSettingsProvider = FutureProvider<PrayerSettings>((ref) {
  final tenantId = ref.watch(currentTenantConfigProvider)?.id ?? 'none';
  return ref.watch(prayerSettingsStoreProvider).load(tenantId);
});

/// Rural areas: the farming services (agri_services_enabled).
final agriEnabledProvider = FutureProvider.autoDispose<bool>(
  (ref) => ref
      .watch(infoEngineApiProvider)
      .agriEnabled()
      .catchError((Object _) => false),
);
