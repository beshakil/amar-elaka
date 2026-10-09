import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/empty_state.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/network/api_exception.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../store/data/store_api.dart';
import '../../store/data/store_models.dart';
import '../application/my_store_providers.dart';
import 'store_messages.dart';

/// "আমার দোকান" (ADR 057): the member's stores and invitations, each with
/// its tools — dashboard, stock, hours, staff, details, "closed today" —
/// as far as their role there allows; or the way to open one.
class MyStoreScreen extends ConsumerWidget {
  const MyStoreScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final stores = ref.watch(myStoresProvider);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.myStoreTitle)),
      body: switch (stores) {
        AsyncData(:final value) when value.isEmpty => EmptyState(
          key: const ValueKey('my-store-none'),
          icon: Icons.storefront_outlined,
          title: l10n.myStoreTitle,
          message: l10n.myStoreNone,
          actionLabel: l10n.myStoreCreate,
          onAction: () => context.push(RoutePaths.myStoreCreate),
        ),
        AsyncData(:final value) => RefreshIndicator(
          onRefresh: () => ref.refresh(myStoresProvider.future),
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              for (final store in value)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: store.accepted
                      ? _StoreCard(store: store)
                      : _Invitation(store: store),
                ),
            ],
          ),
        ),
        AsyncError() => ErrorState(
          title: l10n.myStoreLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(myStoresProvider),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

String roleLabel(AppLocalizations l10n, String role) => switch (role) {
  'owner' => l10n.myStoreRoleOwner,
  'manager' => l10n.myStoreRoleManager,
  _ => l10n.myStoreRoleEditor,
};

class _Invitation extends ConsumerWidget {
  const _Invitation({required this.store});

  final MyStoreSummary store;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return Card(
      key: ValueKey('my-store-invitation-${store.id}'),
      child: ListTile(
        leading: const Icon(Icons.mail_outline),
        title: Text(store.name.of(locale, fallback: store.slug)),
        subtitle: Text(
          '${l10n.myStoreInvited} · ${roleLabel(l10n, store.role)}',
        ),
        trailing: FilledButton(
          onPressed: () async {
            final messenger = ScaffoldMessenger.of(context);
            try {
              await ref.read(storeApiProvider).acceptInvitation(store.id);
              ref.invalidate(myStoresProvider);
            } on AppException catch (error) {
              messenger.showSnackBar(
                SnackBar(content: Text(storeErrorMessage(error, l10n, locale))),
              );
            }
          },
          child: Text(l10n.myStoreAccept),
        ),
      ),
    );
  }
}

class _StoreCard extends ConsumerWidget {
  const _StoreCard({required this.store});

  final MyStoreSummary store;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final runs = store.role == 'owner' || store.role == 'manager';
    final active = store.status == 'active';
    Widget tile(String key, IconData icon, String label, String route) =>
        ListTile(
          key: ValueKey('my-store-$key'),
          leading: Icon(icon),
          title: Text(label),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => context.push(route),
        );

    return Card(
      key: ValueKey('my-store-${store.id}'),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ListTile(
            leading: const Icon(Icons.storefront),
            title: Text(
              store.name.of(locale, fallback: store.slug),
              style: theme.textTheme.titleMedium,
            ),
            subtitle: Text(roleLabel(l10n, store.role)),
          ),
          if (!active)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md,
                0,
                AppSpacing.md,
                AppSpacing.sm,
              ),
              child: Text(
                store.status == 'pending_review'
                    ? l10n.myStorePending
                    : l10n.myStoreNotActive,
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ),
          if (runs && active) _ClosedToday(storeId: store.id),
          const Divider(height: 1),
          if (runs)
            tile(
              'dashboard',
              Icons.insights_outlined,
              l10n.myStoreDashboard,
              RoutePaths.sellerDashboardFor(store.id),
            ),
          tile(
            'stock',
            Icons.inventory_2_outlined,
            l10n.myStoreStock,
            RoutePaths.myStoreStockFor(store.id),
          ),
          if (runs) ...[
            tile(
              'hours',
              Icons.schedule,
              l10n.myStoreHours,
              RoutePaths.myStoreHoursFor(store.id),
            ),
            tile(
              'staff',
              Icons.group_outlined,
              l10n.myStoreStaff,
              RoutePaths.myStoreStaffFor(store.id),
            ),
            tile(
              'edit',
              Icons.edit_outlined,
              l10n.myStoreEditProfile,
              RoutePaths.myStoreEditFor(store.id),
            ),
          ],
          if (active)
            tile(
              'page',
              Icons.open_in_new,
              l10n.myStoreOpenPage,
              RoutePaths.storeFor(store.slug),
            ),
        ],
      ),
    );
  }
}

/// "আজ বন্ধ" — one switch, back to the regular hours tomorrow.
class _ClosedToday extends ConsumerStatefulWidget {
  const _ClosedToday({required this.storeId});

  final String storeId;

  @override
  ConsumerState<_ClosedToday> createState() => _ClosedTodayState();
}

class _ClosedTodayState extends ConsumerState<_ClosedToday> {
  bool? _closed;
  bool _busy = false;

  Future<void> _set(bool closed) async {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final messenger = ScaffoldMessenger.of(context);
    setState(() {
      _busy = true;
      _closed = closed;
    });
    try {
      await ref
          .read(storeApiProvider)
          .setClosedToday(widget.storeId, closed: closed);
      ref.invalidate(storeHoursProvider(widget.storeId));
    } on AppException catch (error) {
      if (mounted) setState(() => _closed = !closed);
      messenger.showSnackBar(
        SnackBar(content: Text(storeErrorMessage(error, l10n, locale))),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final hours = ref.watch(storeHoursProvider(widget.storeId)).value;
    final closed = _closed ?? hours?.closedUntil != null;
    return SwitchListTile(
      key: const ValueKey('my-store-closed-today'),
      secondary: const Icon(Icons.do_not_disturb_on_outlined),
      title: Text(l10n.myStoreClosedToday),
      subtitle: Text(l10n.myStoreClosedTodayHint),
      value: closed,
      onChanged: _busy || hours == null ? null : (v) => unawaited(_set(v)),
    );
  }
}
