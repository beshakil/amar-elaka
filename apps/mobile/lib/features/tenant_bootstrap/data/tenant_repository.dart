import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:dio/dio.dart';
import 'package:drift/drift.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors/auth_interceptor.dart';
import '../../../core/storage/app_database.dart';
import '../../../core/storage/app_database_provider.dart';
import '../../../core/storage/secure_session_storage.dart';

part 'tenant_repository.g.dart';

/// A cached `TenantConfig` row is served as-is (no network call) within this
/// window; past it, it's still served immediately but a background refresh
/// is kicked off (stale-while-revalidate — see [TenantConfigResult.isStale]).
const tenantConfigTtl = Duration(hours: 24);

class TenantConfigResult {
  const TenantConfigResult(this.config, {required this.isStale});

  final TenantConfig config;
  final bool isStale;
}

/// Tenant list/selection and `TenantConfig` fetch-and-cache.
class TenantRepository {
  TenantRepository(this._dio, this._db, this._storage);

  final Dio _dio;
  final AppDatabase _db;
  final SecureSessionStorage _storage;

  Future<List<TenantSummary>> listTenants() async {
    try {
      final response = await _dio.get<List<dynamic>>(
        '/tenants',
        options: Options(extra: {skipAuthKey: true}),
      );
      return response.data!
          .map((json) => TenantSummary.fromJson(json as Map<String, dynamic>))
          .toList();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  /// Auto-select candidate for the location-permission flow. Throws
  /// [ApiException] with `code == 'NO_TENANT_NEARBY'`
  /// (apps/api/src/tenants/tenants.exceptions.ts) when nothing's within
  /// range — same as any other [AppException], the caller decides what "no
  /// match" means for its flow (falls through to the manual picker).
  Future<TenantSummary> findNearby({
    required double lat,
    required double lng,
  }) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/tenants/nearby',
        queryParameters: {'lat': lat, 'lng': lng},
        options: Options(extra: {skipAuthKey: true}),
      );
      return TenantSummary.fromJson(response.data!);
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  Future<void> selectTenant(String tenantId) => _storage.saveTenantId(tenantId);

  /// Cache-first with a 24h TTL and stale-while-revalidate: fresh cache →
  /// returned as-is, no network call. Stale cache → returned immediately
  /// (`isStale: true`); the caller is responsible for triggering
  /// [fetchAndCacheConfig] in the background and re-reading once it lands.
  /// No cache at all → a blocking live fetch, same as [fetchAndCacheConfig].
  Future<TenantConfigResult> getConfig(String tenantId) async {
    final row = await _cachedRow(tenantId);
    if (row == null) {
      return TenantConfigResult(
        await fetchAndCacheConfig(tenantId),
        isStale: false,
      );
    }

    final isStale = DateTime.now().difference(row.cachedAt) > tenantConfigTtl;
    return TenantConfigResult(await _configFromRow(row), isStale: isStale);
  }

  Future<TenantConfig> fetchAndCacheConfig(String tenantId) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        '/tenant/config',
        options: Options(extra: {skipAuthKey: true}),
      );
      final config = TenantConfig.fromJson(response.data!);
      await _cacheConfig(config);
      return config;
    } on DioException catch (e) {
      final row = await _cachedRow(tenantId);
      if (row != null) return _configFromRow(row);
      throw mapDioException(e);
    }
  }

  Future<TenantConfigCacheRow?> _cachedRow(String tenantId) {
    return (_db.select(
      _db.tenantConfigCache,
    )..where((t) => t.id.equals(tenantId))).getSingleOrNull();
  }

  Future<TenantConfig> _configFromRow(TenantConfigCacheRow row) async {
    final contacts = await (_db.select(
      _db.emergencyContactCache,
    )..where((t) => t.tenantId.equals(row.id))).get();

    return TenantConfig(
      id: row.id,
      slug: row.slug,
      nameBn: row.nameBn,
      nameEn: row.nameEn,
      defaultLocale: row.defaultLocale,
      mapCenter: LatLng(lat: row.mapCenterLat, lng: row.mapCenterLng),
      radiusKm: row.radiusKm,
      branding: TenantBranding(logoStorageKey: row.logoStorageKey),
      // Feature flags aren't cached — only ever read from a live response.
      featureFlags: const {},
      enabledCategories: row.enabledCategories,
      emergencyNumbers: contacts
          .map(
            (c) => EmergencyNumber(
              serviceType: c.serviceType,
              nameBn: c.nameBn,
              nameEn: c.nameEn,
              phones: c.phones,
              is24h: c.is24h,
            ),
          )
          .toList(),
      support: TenantSupport(
        phoneE164: row.supportPhone,
        email: row.supportEmail,
        whatsappE164: row.supportWhatsapp,
      ),
    );
  }

  Future<void> _cacheConfig(TenantConfig config) async {
    await _db
        .into(_db.tenantConfigCache)
        .insertOnConflictUpdate(
          TenantConfigCacheCompanion.insert(
            id: config.id,
            slug: config.slug,
            nameBn: config.nameBn,
            nameEn: config.nameEn,
            defaultLocale: config.defaultLocale,
            mapCenterLat: config.mapCenter.lat,
            mapCenterLng: config.mapCenter.lng,
            radiusKm: Value(config.radiusKm),
            logoStorageKey: Value(config.branding.logoStorageKey),
            enabledCategories: config.enabledCategories,
            supportPhone: Value(config.support.phoneE164),
            supportEmail: Value(config.support.email),
            supportWhatsapp: Value(config.support.whatsappE164),
            cachedAt: DateTime.now(),
          ),
        );

    await (_db.delete(
      _db.emergencyContactCache,
    )..where((t) => t.tenantId.equals(config.id))).go();
    if (config.emergencyNumbers.isNotEmpty) {
      await _db.batch((batch) {
        batch.insertAll(
          _db.emergencyContactCache,
          config.emergencyNumbers.map(
            (e) => EmergencyContactCacheCompanion.insert(
              tenantId: config.id,
              serviceType: e.serviceType,
              nameBn: e.nameBn,
              nameEn: Value(e.nameEn),
              phones: e.phones,
              is24h: e.is24h,
            ),
          ),
        );
      });
    }
  }
}

@riverpod
TenantRepository tenantRepository(Ref ref) {
  return TenantRepository(
    ref.watch(dioClientProvider),
    ref.watch(appDatabaseProvider),
    ref.watch(secureSessionStorageProvider),
  );
}
