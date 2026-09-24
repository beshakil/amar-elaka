import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../l10n/app_localizations.dart';
import '../../network/connectivity_provider.dart';
import '../tokens/app_spacing.dart';

/// A slim banner shown above every screen while offline (wired from
/// `app.dart`'s `MaterialApp.router.builder`, not per-screen) — cached
/// content still renders underneath it; this only says the network is
/// gone, it doesn't block anything.
class OfflineBanner extends ConsumerWidget {
  const OfflineBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isOnline = ref.watch(isOnlineProvider).value ?? true;
    if (isOnline) return const SizedBox.shrink();

    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return Material(
      color: colors.errorContainer,
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.md,
            vertical: AppSpacing.xs,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.cloud_off_outlined,
                size: 16,
                color: colors.onErrorContainer,
              ),
              const SizedBox(width: AppSpacing.xs),
              Text(
                l10n.offlineBannerMessage,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  color: colors.onErrorContainer,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
