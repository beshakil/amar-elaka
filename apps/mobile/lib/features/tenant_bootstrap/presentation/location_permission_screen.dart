import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../l10n/app_localizations.dart';
import '../application/tenant_bootstrap_controller.dart';

/// First-launch rationale, shown *before* the OS permission dialog — no OS
/// dialog copy to write, just why the app wants this.
class LocationPermissionScreen extends ConsumerStatefulWidget {
  const LocationPermissionScreen({super.key});

  @override
  ConsumerState<LocationPermissionScreen> createState() =>
      _LocationPermissionScreenState();
}

class _LocationPermissionScreenState
    extends ConsumerState<LocationPermissionScreen> {
  bool _isRequesting = false;

  Future<void> _allow() async {
    setState(() => _isRequesting = true);
    await ref
        .read(tenantBootstrapControllerProvider.notifier)
        .requestLocationAndFindNearby();
    if (mounted) setState(() => _isRequesting = false);
  }

  Future<void> _skip() =>
      ref.read(tenantBootstrapControllerProvider.notifier).skipLocation();

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
                Icons.location_on_outlined,
                size: 64,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                l10n.locationPermissionTitle,
                style: Theme.of(context).textTheme.headlineMedium,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.sm),
              Text(
                l10n.locationPermissionRationale,
                style: Theme.of(context).textTheme.bodyLarge,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: AppSpacing.xl),
              AppButton(
                label: l10n.locationAllowButton,
                onPressed: _allow,
                isLoading: _isRequesting,
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: l10n.locationSkipButton,
                variant: AppButtonVariant.text,
                onPressed: _skip,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
