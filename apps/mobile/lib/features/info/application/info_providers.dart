import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../../post/application/current_tenant.dart';
import '../../tenant_bootstrap/data/location_service.dart';
import '../data/emergency_repository.dart';
import '../data/info_api.dart';
import '../data/info_models.dart';

/// The emergency page on screen (ADR 064). Never an error and never empty:
/// the kept copy (or the bundled hotlines) shows at once, then a refresh
/// replaces it when the network answers. Null only for the first instant.
class EmergencyController extends Notifier<EmergencySnapshot?> {
  bool _refreshing = false;

  @override
  EmergencySnapshot? build() {
    final tenantId = ref.watch(currentTenantConfigProvider)?.id ?? 'none';
    unawaited(_load(tenantId));
    return null;
  }

  bool get refreshing => _refreshing;

  Future<void> _load(String tenantId) async {
    final repo = ref.read(emergencyRepositoryProvider);
    final local = await repo.local(tenantId);
    if (!ref.mounted) return;
    state = local;
    if (tenantId != 'none') await refresh();
  }

  /// Pull-to-refresh and the open-time refresh; a failure keeps what is shown.
  Future<void> refresh() async {
    final tenantId = ref.read(currentTenantConfigProvider)?.id;
    if (tenantId == null || _refreshing) return;
    _refreshing = true;
    try {
      final fresh = await ref
          .read(emergencyRepositoryProvider)
          .refresh(tenantId);
      if (fresh != null && ref.mounted) state = fresh;
    } finally {
      _refreshing = false;
    }
  }
}

final emergencyControllerProvider =
    NotifierProvider<EmergencyController, EmergencySnapshot?>(
      EmergencyController.new,
    );

/// The background refresh: watched by the app shell, so the offline copy is
/// renewed every `refreshAfterSeconds` without the screen being opened.
final emergencyPrefetchProvider = Provider<void>((ref) {
  final tenantId = ref.watch(currentTenantConfigProvider)?.id;
  if (tenantId == null) return;
  unawaited(ref.read(emergencyRepositoryProvider).refreshIfStale(tenantId));
});

/// Field agents and the area's staff: the bazar entry and contact upkeep.
final isAreaTeamProvider = Provider<bool>((ref) {
  final auth = ref.watch(authControllerProvider);
  return auth is AuthSessionAuthenticated &&
      const {
        'agent',
        'moderator',
        'tenant_admin',
        'partner_owner',
      }.contains(auth.me.role);
});

final isSignedInProvider = Provider<bool>(
  (ref) => ref.watch(authControllerProvider) is AuthSessionAuthenticated,
);

/// The viewer's point for a radius search; null = the area's centre (the API's fallback).
final viewerOriginProvider =
    FutureProvider.autoDispose<({double lat, double lng})?>((ref) async {
      final result = await ref
          .read(locationServiceProvider)
          .requestAndGetPosition();
      return switch (result) {
        LocationGranted(:final latitude, :final longitude) => (
          lat: latitude,
          lng: longitude,
        ),
        _ => null,
      };
    });

/// One price board per kind: `bazar` or `agri` (ADR 065).
final bazarBoardProvider = FutureProvider.autoDispose
    .family<BazarBoard, String>(
      (ref, board) => ref.watch(infoApiProvider).bazarBoard(board: board),
    );

final bazarEntryProvider = FutureProvider.autoDispose
    .family<BazarEntrySheet, ({String? date, String board})>(
      (ref, key) => ref
          .watch(infoApiProvider)
          .bazarEntry(date: key.date, board: key.board),
    );

final myDonorProvider = FutureProvider.autoDispose<MyDonor?>(
  (ref) => ref.watch(infoApiProvider).myDonor(),
);

final myDonorContactsProvider =
    FutureProvider.autoDispose<List<DonorContactEntry>>(
      (ref) => ref.watch(infoApiProvider).myContacts(),
    );

final nearbyRequestsProvider =
    FutureProvider.autoDispose<List<BloodRequestCard>>((ref) async {
      final origin = await ref.watch(viewerOriginProvider.future);
      return ref
          .watch(infoApiProvider)
          .requests(lat: origin?.lat, lng: origin?.lng);
    });

final myRequestsProvider = FutureProvider.autoDispose<List<BloodRequestCard>>(
  (ref) => ref.watch(infoApiProvider).myRequests(),
);

final bloodRequestProvider = FutureProvider.autoDispose
    .family<BloodRequestDetail, String>(
      (ref, id) => ref.watch(infoApiProvider).request(id),
    );
