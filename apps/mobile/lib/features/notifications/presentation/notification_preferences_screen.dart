import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../l10n/app_localizations.dart';
import '../data/notification_settings_api.dart';

/// The settings: per type, per channel, as the API says (ADR 059).
class NotificationPreferencesController
    extends AsyncNotifier<List<TypePreference>> {
  NotificationSettingsApi get _api => ref.read(notificationSettingsApiProvider);

  @override
  Future<List<TypePreference>> build() =>
      ref.watch(notificationSettingsApiProvider).preferences();

  /// The switch moves at once; back, with an error, if the server refuses.
  Future<void> toggle(
    String type,
    String channel, {
    required bool enabled,
  }) async {
    final current = state.value;
    if (current == null) return;
    state = AsyncData([
      for (final t in current)
        t.type != type
            ? t
            : TypePreference(
                type: t.type,
                urgent: t.urgent,
                channels: [
                  for (final c in t.channels)
                    c.channel == channel ? c.withEnabled(enabled) : c,
                ],
              ),
    ]);
    try {
      state = AsyncData(
        await _api.setPreference(type, channel, enabled: enabled),
      );
    } on Object {
      state = AsyncData(current);
      rethrow;
    }
  }
}

final notificationPreferencesProvider =
    AsyncNotifierProvider.autoDispose<
      NotificationPreferencesController,
      List<TypePreference>
    >(NotificationPreferencesController.new);

/// A type's name in the settings, from its code (notification_types).
String notificationTypeLabel(String type, AppLocalizations l10n) =>
    switch (type) {
      'new_message' => l10n.typeNewMessage,
      'post_approved' ||
      'post_rejected' ||
      'post_removed' => l10n.typePostOutcome,
      'post_expiring' => l10n.typePostExpiring,
      'saved_search_match' => l10n.typeSavedSearchMatch,
      'saved_search_paused' => l10n.typeSavedSearchPaused,
      'saved_search_weekly_digest' => l10n.typeSavedSearchDigest,
      'saved_post_price_drop' => l10n.typePriceDrop,
      'place_approved' || 'place_rejected' => l10n.typePlace,
      'place_claim_approved' || 'place_claim_rejected' => l10n.typeClaim,
      'place_edit_approved' || 'place_edit_rejected' => l10n.typePlaceEdit,
      'store_staff_invited' => l10n.typeStaffInvite,
      'store_suspended' || 'store_reinstated' => l10n.typeStoreStatus,
      'store_import_finished' => l10n.typeImport,
      'ban_issued' || 'appeal_decided' => l10n.typeAccount,
      _ => l10n.typeOther,
    };

String _channelLabel(String channel, AppLocalizations l10n) =>
    switch (channel) {
      'push' => l10n.channelPush,
      'email' => l10n.channelEmail,
      'sms' => l10n.channelSms,
      _ => l10n.channelInApp,
    };

class NotificationPreferencesScreen extends ConsumerWidget {
  const NotificationPreferencesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final prefs = ref.watch(notificationPreferencesProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.notificationSettingsTitle)),
      body: switch (prefs) {
        AsyncData(:final value) => ListView(
          key: const ValueKey('notification-preferences'),
          padding: const EdgeInsets.only(bottom: AppSpacing.lg),
          children: [
            Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Text(
                l10n.notificationSettingsIntro,
                style: theme.textTheme.bodyMedium,
              ),
            ),
            // Types that read the same in the settings (approved / rejected) are one entry.
            for (final type in _distinctByLabel(value, l10n)) ...[
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.md,
                  AppSpacing.md,
                  AppSpacing.md,
                  0,
                ),
                child: Text(
                  notificationTypeLabel(type.type, l10n),
                  style: theme.textTheme.titleSmall,
                ),
              ),
              for (final channel in type.channels.where(
                (c) => c.channel != 'in_app',
              ))
                SwitchListTile(
                  key: ValueKey('pref-${type.type}-${channel.channel}'),
                  title: Text(_channelLabel(channel.channel, l10n)),
                  subtitle: channel.locked
                      ? Text(l10n.notificationSettingsLocked)
                      : null,
                  value: channel.enabled,
                  onChanged: channel.locked
                      ? null
                      : (on) => unawaited(
                          _toggle(
                            context,
                            ref,
                            value,
                            type,
                            channel.channel,
                            on,
                          ),
                        ),
                ),
            ],
          ],
        ),
        AsyncError() => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(l10n.notificationSettingsFailed),
              TextButton(
                onPressed: () =>
                    ref.invalidate(notificationPreferencesProvider),
                child: Text(l10n.chatRetry),
              ),
            ],
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  /// One switch moves every type that shares its label (post approved, rejected, removed).
  Future<void> _toggle(
    BuildContext context,
    WidgetRef ref,
    List<TypePreference> all,
    TypePreference shown,
    String channel,
    bool on,
  ) async {
    final l10n = AppLocalizations.of(context)!;
    final messenger = ScaffoldMessenger.of(context);
    final label = notificationTypeLabel(shown.type, l10n);
    final controller = ref.read(notificationPreferencesProvider.notifier);
    try {
      for (final t in all.where(
        (t) => notificationTypeLabel(t.type, l10n) == label,
      )) {
        if (t.channels.any((c) => c.channel == channel && !c.locked)) {
          await controller.toggle(t.type, channel, enabled: on);
        }
      }
    } on Object {
      messenger.showSnackBar(
        SnackBar(content: Text(l10n.notificationSettingsSaveFailed)),
      );
    }
  }

  static List<TypePreference> _distinctByLabel(
    List<TypePreference> all,
    AppLocalizations l10n,
  ) {
    final seen = <String>{};
    return [
      for (final t in all)
        if (seen.add(notificationTypeLabel(t.type, l10n))) t,
    ];
  }
}
