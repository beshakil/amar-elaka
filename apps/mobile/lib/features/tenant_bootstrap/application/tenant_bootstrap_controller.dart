import 'dart:async';

import 'package:riverpod_annotation/riverpod_annotation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../data/location_service.dart';
import '../data/tenant_repository.dart';
import '../domain/tenant_bootstrap_state.dart';

part 'tenant_bootstrap_controller.g.dart';

const _locationAskedPrefsKey = 'tenant_bootstrap.location_asked';

/// Drives the whole tenant-bootstrap flow: location rationale →
/// (auto-select + confirm) or (denied/no-match/skip → picker) → ready, and
/// the cache-first reload on every subsequent launch.
@riverpod
class TenantBootstrapController extends _$TenantBootstrapController {
  @override
  Future<TenantBootstrapState> build() async {
    final storage = ref.watch(secureSessionStorageProvider);
    final repo = ref.watch(tenantRepositoryProvider);

    final tenantId = await storage.readTenantId();
    if (tenantId != null) {
      final result = await repo.getConfig(tenantId);
      if (result.isStale) {
        unawaited(_refreshInBackground(tenantId));
      }
      return TenantBootstrapReady(result.config, isStale: result.isStale);
    }

    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_locationAskedPrefsKey) != true) {
      return const TenantBootstrapNeedsLocationDecision();
    }
    return TenantBootstrapNeedsSelection(await repo.listTenants());
  }

  Future<void> _refreshInBackground(String tenantId) async {
    try {
      final config = await ref
          .read(tenantRepositoryProvider)
          .fetchAndCacheConfig(tenantId);
      if (!ref.mounted) return;
      // The user may have switched tenants (or retried) while this refresh
      // was in flight — only apply it if it's still the persisted tenant,
      // otherwise it would clobber whatever newer state took over meanwhile.
      final currentTenantId = await ref
          .read(secureSessionStorageProvider)
          .readTenantId();
      if (currentTenantId == tenantId) {
        state = AsyncData(TenantBootstrapReady(config, isStale: false));
      }
    } on AppException {
      // Still-stale cache keeps serving; nothing else to do.
    }
  }

  Future<void> requestLocationAndFindNearby() async {
    await _markLocationAsked();
    final locationService = ref.read(locationServiceProvider);
    final repo = ref.read(tenantRepositoryProvider);

    final location = await locationService.requestAndGetPosition();
    if (location is! LocationGranted) {
      state = await AsyncValue.guard(
        () async => TenantBootstrapNeedsSelection(await repo.listTenants()),
      );
      return;
    }

    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      try {
        final candidate = await repo.findNearby(
          lat: location.latitude,
          lng: location.longitude,
        );
        return TenantBootstrapConfirmNearby(candidate);
      } on AppException {
        // No coverage nearby, or the lookup failed — the picker is always
        // the fallback, never a dead end.
        return TenantBootstrapNeedsSelection(await repo.listTenants());
      }
    });
  }

  Future<void> skipLocation() async {
    await _markLocationAsked();
    final repo = ref.read(tenantRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(
      () async => TenantBootstrapNeedsSelection(await repo.listTenants()),
    );
  }

  Future<void> confirmNearby(String tenantId) => selectTenant(tenantId);

  Future<void> rejectNearby() async {
    final repo = ref.read(tenantRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(
      () async => TenantBootstrapNeedsSelection(await repo.listTenants()),
    );
  }

  Future<void> selectTenant(String tenantId) async {
    final repo = ref.read(tenantRepositoryProvider);
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(() async {
      await repo.selectTenant(tenantId);
      return TenantBootstrapReady(
        await repo.fetchAndCacheConfig(tenantId),
        isStale: false,
      );
    });
  }

  /// Clears the persisted tenant (tenant-switcher's "change area") and
  /// starts the flow over from the picker — not the location rationale
  /// again, since the user is explicitly choosing, not a first launch.
  Future<void> switchTenant() async {
    final storage = ref.read(secureSessionStorageProvider);
    final repo = ref.read(tenantRepositoryProvider);
    await storage.clearTenantId();
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(
      () async => TenantBootstrapNeedsSelection(await repo.listTenants()),
    );
  }

  Future<void> retry() async {
    ref.invalidateSelf();
    await future;
  }

  Future<void> _markLocationAsked() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_locationAskedPrefsKey, true);
  }
}
