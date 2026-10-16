import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../tenant_bootstrap/application/tenant_bootstrap_controller.dart';

/// `AppRouter`'s `redirect` callback (watching tenant-bootstrap and auth
/// state) decides where to go *from* here once bootstrap resolves — this
/// screen only needs to show progress, and the one actionable failure that
/// can happen before there's anywhere else to send the user: tenant
/// bootstrap itself failing (no cache, no network, first launch).
class SplashScreen extends ConsumerWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final bootstrap = ref.watch(tenantBootstrapControllerProvider);

    return Scaffold(
      body: Center(
        child: bootstrap.hasError
            ? Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ErrorState(
                    title: l10n.errorGenericTitle,
                    message: l10n.errorGenericMessage,
                    retryLabel: l10n.genericRetry,
                    onRetry: () => ref
                        .read(tenantBootstrapControllerProvider.notifier)
                        .retry(),
                  ),
                  // No area yet, no network: the emergency numbers still open
                  // (the ones shipped in the app, ADR 064).
                  TextButton.icon(
                    onPressed: () => context.push(RoutePaths.emergency),
                    icon: const Icon(Icons.emergency_outlined),
                    label: Text(l10n.emergencyAllNumbers),
                  ),
                ],
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    l10n.appTitle,
                    style: Theme.of(context).textTheme.displayMedium,
                  ),
                  const SizedBox(height: AppSpacing.lg),
                  const CircularProgressIndicator(),
                ],
              ),
      ),
    );
  }
}
