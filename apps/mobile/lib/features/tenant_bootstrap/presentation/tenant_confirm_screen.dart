import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../l10n/app_localizations.dart';
import '../application/tenant_bootstrap_controller.dart';

class TenantConfirmScreen extends ConsumerStatefulWidget {
  const TenantConfirmScreen({required this.candidate, super.key});

  final TenantSummary candidate;

  @override
  ConsumerState<TenantConfirmScreen> createState() =>
      _TenantConfirmScreenState();
}

class _TenantConfirmScreenState extends ConsumerState<TenantConfirmScreen> {
  bool _isConfirming = false;

  Future<void> _confirm() async {
    setState(() => _isConfirming = true);
    await ref
        .read(tenantBootstrapControllerProvider.notifier)
        .confirmNearby(widget.candidate.id);
    if (mounted) setState(() => _isConfirming = false);
  }

  Future<void> _reject() =>
      ref.read(tenantBootstrapControllerProvider.notifier).rejectNearby();

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.lg),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Icon(
                Icons.place,
                size: 64,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                l10n.tenantConfirmTitle,
                style: Theme.of(context).textTheme.headlineMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                l10n.tenantConfirmMessage(widget.candidate.nameBn),
                style: Theme.of(context).textTheme.bodyLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.xl),
              AppButton(
                label: l10n.tenantConfirmYesButton,
                onPressed: _confirm,
                isLoading: _isConfirming,
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: l10n.tenantConfirmChooseDifferentButton,
                variant: AppButtonVariant.text,
                onPressed: _reject,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
