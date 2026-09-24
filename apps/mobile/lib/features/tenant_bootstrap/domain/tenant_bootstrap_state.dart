import 'package:amar_elaka_api/amar_elaka_api.dart';

/// The four "we have data" outcomes of tenant bootstrap. Loading/error are
/// left to `AsyncValue` (the controller is an `AsyncNotifier`) rather than
/// duplicated here.
sealed class TenantBootstrapState {
  const TenantBootstrapState();
}

/// First run, no tenant persisted, location permission never asked —
/// show the rationale screen.
final class TenantBootstrapNeedsLocationDecision extends TenantBootstrapState {
  const TenantBootstrapNeedsLocationDecision();
}

/// `/tenants/nearby` found a candidate — confirm before committing to it.
final class TenantBootstrapConfirmNearby extends TenantBootstrapState {
  const TenantBootstrapConfirmNearby(this.candidate);

  final TenantSummary candidate;
}

/// Denied/no-match/skip — show the (district-grouped) picker.
final class TenantBootstrapNeedsSelection extends TenantBootstrapState {
  const TenantBootstrapNeedsSelection(this.tenants);

  final List<TenantSummary> tenants;
}

/// A tenant is selected and its config is loaded (live or cached).
/// [isStale] is true when this came from a past-TTL cache entry — a
/// background refresh is already in flight (`TenantRepository.getConfig`)
/// and will land silently once it completes.
final class TenantBootstrapReady extends TenantBootstrapState {
  const TenantBootstrapReady(this.config, {required this.isStale});

  final TenantConfig config;
  final bool isStale;
}
