import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../tenant_bootstrap/application/tenant_bootstrap_controller.dart';
import '../../tenant_bootstrap/domain/tenant_bootstrap_state.dart';

/// The tenant the app is bootstrapped into (name for the boundary warning,
/// the typical review time for the submit result); null before bootstrap.
final currentTenantConfigProvider = Provider<TenantConfig?>(
  (ref) => switch (ref.watch(tenantBootstrapControllerProvider)) {
    AsyncData(value: TenantBootstrapReady(:final config)) => config,
    _ => null,
  },
);
