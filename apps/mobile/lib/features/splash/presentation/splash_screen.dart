import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/error_state.dart';
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
            ? ErrorState(
                title: l10n.errorGenericTitle,
                message: l10n.errorGenericMessage,
                retryLabel: l10n.genericRetry,
                onRetry: () => ref
                    .read(tenantBootstrapControllerProvider.notifier)
                    .retry(),
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
