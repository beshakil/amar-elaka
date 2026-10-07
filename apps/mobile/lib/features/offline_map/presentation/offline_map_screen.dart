import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_button.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../l10n/app_localizations.dart';
import '../application/offline_map_controller.dart';
import '../application/offline_map_prefs.dart';

/// "এলাকার ম্যাপ ডাউনলোড" (ADR 050): the size before anything downloads,
/// progress (with cancel; a later tap resumes), a newer version notice,
/// delete, and the two switches (auto-update on Wi-Fi; use the downloaded
/// map even online).
class OfflineMapScreen extends ConsumerStatefulWidget {
  const OfflineMapScreen({super.key});

  @override
  ConsumerState<OfflineMapScreen> createState() => _OfflineMapScreenState();
}

class _OfflineMapScreenState extends ConsumerState<OfflineMapScreen> {
  @override
  void initState() {
    super.initState();
    // Ask for the size (and any newer version) as the screen opens.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        unawaited(ref.read(offlineMapControllerProvider.notifier).check());
      }
    });
  }

  Future<void> _confirmDelete() async {
    final l10n = AppLocalizations.of(context)!;
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.offlineMapDeleteTitle),
        content: Text(l10n.offlineMapDeleteMessage),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(l10n.offlineMapCancel),
          ),
          TextButton(
            key: const ValueKey('offline-map-delete-confirm'),
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(l10n.offlineMapDelete),
          ),
        ],
      ),
    );
    if (ok ?? false) {
      await ref.read(offlineMapControllerProvider.notifier).delete();
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final state = ref.watch(offlineMapControllerProvider);
    final controller = ref.read(offlineMapControllerProvider.notifier);
    final prefs = ref.watch(offlineMapPrefsProvider).value;
    final installed = state.installed;
    final manifest = state.manifest;
    final downloading = state.phase == OfflineMapPhase.downloading;
    String size(int bytes) => megabytes(bytes, locale);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.offlineMapTitle)),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Text(l10n.offlineMapIntro, style: theme.textTheme.bodyMedium),
          const SizedBox(height: AppSpacing.md),
          if (installed != null)
            Card(
              key: const ValueKey('offline-map-installed'),
              child: ListTile(
                leading: const Icon(Icons.offline_pin_outlined),
                title: Text(l10n.offlineMapInstalled(size(installed.bytes))),
                subtitle: Text(
                  l10n.offlineMapInstalledOn(
                    MaterialLocalizations.of(
                      context,
                    ).formatMediumDate(installed.downloadedAt.toLocal()),
                  ),
                ),
              ),
            ),
          if (state.updateAvailable && !downloading)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text(
                l10n.offlineMapUpdateAvailable(size(manifest!.totalBytes)),
                key: const ValueKey('offline-map-update'),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.primary,
                ),
              ),
            ),
          if (state.phase == OfflineMapPhase.checking)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: AppSpacing.sm),
              child: LinearProgressIndicator(),
            ),
          if (downloading) ...[
            const SizedBox(height: AppSpacing.sm),
            LinearProgressIndicator(
              key: const ValueKey('offline-map-progress'),
              value: state.total == 0 ? null : state.progress,
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              l10n.offlineMapProgress(size(state.done), size(state.total)),
              style: theme.textTheme.bodySmall,
            ),
          ],
          if (state.error case final error?)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              child: Text(
                switch (error) {
                  OfflineMapError.network => l10n.offlineMapErrorNetwork,
                  OfflineMapError.checksum => l10n.offlineMapErrorChecksum,
                  OfflineMapError.notAvailable =>
                    l10n.offlineMapErrorNotAvailable,
                  OfflineMapError.tooLarge => l10n.offlineMapErrorTooLarge,
                  OfflineMapError.failed => l10n.offlineMapErrorFailed,
                },
                key: const ValueKey('offline-map-error'),
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.error,
                ),
              ),
            ),
          const SizedBox(height: AppSpacing.md),
          if (downloading)
            AppButton(
              key: const ValueKey('offline-map-cancel'),
              label: l10n.offlineMapCancel,
              variant: AppButtonVariant.secondary,
              icon: Icons.close,
              onPressed: controller.cancel,
            )
          else if (manifest != null &&
              manifest.available &&
              (installed == null || state.updateAvailable))
            AppButton(
              key: const ValueKey('offline-map-download'),
              // The size is shown before anything is downloaded.
              label: installed == null
                  ? l10n.offlineMapDownload(size(manifest.totalBytes))
                  : l10n.offlineMapUpdate(size(manifest.totalBytes)),
              icon: Icons.download_outlined,
              onPressed: () => unawaited(controller.download()),
            ),
          if (installed != null && !downloading)
            AppButton(
              key: const ValueKey('offline-map-delete'),
              label: l10n.offlineMapDelete,
              variant: AppButtonVariant.text,
              icon: Icons.delete_outline,
              onPressed: () => unawaited(_confirmDelete()),
            ),
          const Divider(height: AppSpacing.xl),
          SwitchListTile(
            key: const ValueKey('offline-map-auto-update'),
            title: Text(l10n.offlineMapAutoUpdate),
            subtitle: Text(l10n.offlineMapAutoUpdateHint),
            value: prefs?.autoUpdateOnWifi ?? true,
            onChanged: prefs == null
                ? null
                : (value) => unawaited(
                    ref
                        .read(offlineMapPrefsProvider.notifier)
                        .setAutoUpdateOnWifi(value),
                  ),
          ),
          SwitchListTile(
            key: const ValueKey('offline-map-use-downloaded'),
            title: Text(l10n.offlineMapUseDownloaded),
            subtitle: Text(l10n.offlineMapUseDownloadedHint),
            value: prefs?.useDownloadedMap ?? true,
            onChanged: prefs == null
                ? null
                : (value) => unawaited(
                    ref
                        .read(offlineMapPrefsProvider.notifier)
                        .setUseDownloadedMap(value),
                  ),
          ),
        ],
      ),
    );
  }
}

/// "১.৯ MB" — one decimal, the reader's digits.
String megabytes(int bytes, String locale) => localizeDigits(
  // 1 MB = 1024 × 1024 bytes.
  (bytes / (1024 * 1024)).toStringAsFixed(1),
  locale,
);
