import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/routing/deep_links.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/inbox_controller.dart';
import '../data/notifications_api.dart';
import 'notification_text.dart';

/// The inbox: newest first, unread ones marked; opening one marks it read
/// and follows its link when the app has that screen.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final locale = Localizations.localeOf(context).languageCode;
    final inbox = ref.watch(inboxControllerProvider);
    final controller = ref.read(inboxControllerProvider.notifier);
    final hasUnread = inbox.value?.items.any((i) => !i.read) ?? false;

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.notificationsTitle),
        actions: [
          IconButton(
            key: const ValueKey('notifications-settings'),
            tooltip: l10n.notificationsSettings,
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => unawaited(context.push(RoutePaths.notificationPreferences)),
          ),
          if (hasUnread)
            TextButton(
              key: const ValueKey('notifications-read-all'),
              onPressed: () => unawaited(controller.markAllRead()),
              child: Text(l10n.notificationsReadAll),
            ),
        ],
      ),
      body: switch (inbox) {
        AsyncData(:final value) when value.items.isEmpty => Center(
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.lg),
            child: Text(
              l10n.notificationsEmpty,
              key: const ValueKey('notifications-empty'),
              textAlign: TextAlign.center,
            ),
          ),
        ),
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(inboxControllerProvider.future),
          child: ListView.separated(
            key: const ValueKey('notifications-list'),
            itemCount: value.items.length + (value.hasMore ? 1 : 0),
            separatorBuilder: (_, _) => const Divider(height: 1),
            itemBuilder: (context, index) {
              if (index >= value.items.length) {
                // Not during build: ask for the next page after this frame.
                WidgetsBinding.instance.addPostFrameCallback(
                  (_) => unawaited(controller.loadMore()),
                );
                return const Padding(
                  padding: EdgeInsets.all(AppSpacing.md),
                  child: Center(child: CircularProgressIndicator()),
                );
              }
              final item = value.items[index];
              // The server's own words; the app's only for an older row without them.
              final fallback = notificationText(item, l10n, locale);
              final text = (title: item.title ?? fallback.title, body: item.body ?? fallback.body);
              return ListTile(
                key: ValueKey('notification-${item.id}'),
                leading: Icon(
                  _iconFor(item.type),
                  color: item.read
                      ? theme.colorScheme.onSurfaceVariant
                      : theme.colorScheme.primary,
                ),
                title: Text(
                  text.title,
                  style: item.read
                      ? null
                      : const TextStyle(fontWeight: FontWeight.w600),
                ),
                subtitle: text.body == null ? null : Text(text.body!),
                trailing: item.read
                    ? null
                    : Icon(
                        Icons.circle,
                        size: AppSpacing.sm,
                        color: theme.colorScheme.primary,
                      ),
                onTap: () => _open(context, controller, item),
              );
            },
          ),
        ),
        AsyncError() => Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(l10n.notificationsFailed),
              TextButton(
                onPressed: () => ref.invalidate(inboxControllerProvider),
                child: Text(l10n.placeFeedbackRetry),
              ),
            ],
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }

  void _open(BuildContext context, InboxController controller, InboxItem item) {
    unawaited(controller.markRead(item));
    final route = appRouteForDeepLink(item.deepLink);
    if (route != null) unawaited(context.push(route));
  }

  static IconData _iconFor(String type) => switch (type) {
    final t when t.startsWith('post_') => Icons.campaign_outlined,
    final t when t.startsWith('saved_search_') => Icons.bookmarks_outlined,
    final t when t.startsWith('place_') => Icons.place_outlined,
    final t when t.startsWith('geo_budget_') => Icons.warning_amber_outlined,
    'new_message' => Icons.chat_bubble_outline,
    'saved_post_price_drop' => Icons.trending_down,
    final t when t.startsWith('store_') => Icons.storefront_outlined,
    _ => Icons.notifications_outlined,
  };
}

/// The app bar's bell with the unread count; signed-in users only.
class NotificationsBell extends ConsumerWidget {
  const NotificationsBell({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final unread = ref.watch(unreadNotificationsProvider).value ?? 0;
    return IconButton(
      key: const ValueKey('notifications-bell'),
      tooltip: l10n.notificationsTitle,
      icon: Badge(
        isLabelVisible: unread > 0,
        label: Text(localizeDigits('$unread', locale)),
        child: const Icon(Icons.notifications_outlined),
      ),
      onPressed: () async {
        await context.push(RoutePaths.notifications);
        ref.invalidate(unreadNotificationsProvider);
      },
    );
  }
}
