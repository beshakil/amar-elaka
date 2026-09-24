import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/tenant_bootstrap/application/tenant_bootstrap_controller.dart';
import '../../features/tenant_bootstrap/domain/tenant_bootstrap_state.dart';
import '../../l10n/app_localizations.dart';
import '../design/widgets/app_bottom_sheet.dart';
import '../design/widgets/app_button.dart';
import '../design/tokens/app_spacing.dart';

/// The bottom-nav shell: Home, Map, Post, Info, Profile — each an
/// independent navigation stack via `StatefulShellRoute.indexedStack`
/// (switching tabs preserves each tab's own scroll/route state). Owns a
/// single shared `AppBar` (title follows the active tab, tenant switcher on
/// the right) instead of each tab screen declaring its own.
class AppShell extends ConsumerWidget {
  const AppShell({required this.navigationShell, super.key});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final titles = [
      l10n.navHome,
      l10n.navMap,
      l10n.navPost,
      l10n.navInfo,
      l10n.navProfile,
    ];
    final tenantState = ref.watch(tenantBootstrapControllerProvider);
    final tenantName = switch (tenantState) {
      AsyncData(value: TenantBootstrapReady(:final config)) => config.nameBn,
      _ => null,
    };

    return Scaffold(
      appBar: AppBar(
        title: Text(titles[navigationShell.currentIndex]),
        actions: [
          if (tenantName != null)
            TextButton.icon(
              onPressed: () => _showTenantSwitcher(context, ref, tenantName),
              icon: const Icon(Icons.expand_more),
              label: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 96),
                child: Text(tenantName, overflow: TextOverflow.ellipsis),
              ),
            ),
        ],
      ),
      body: navigationShell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: navigationShell.currentIndex,
        onDestinationSelected: (index) => navigationShell.goBranch(
          index,
          initialLocation: index == navigationShell.currentIndex,
        ),
        destinations: [
          NavigationDestination(
            icon: const Icon(Icons.home_outlined),
            selectedIcon: const Icon(Icons.home),
            label: l10n.navHome,
          ),
          NavigationDestination(
            icon: const Icon(Icons.map_outlined),
            selectedIcon: const Icon(Icons.map),
            label: l10n.navMap,
          ),
          NavigationDestination(
            icon: const Icon(Icons.add_box_outlined),
            selectedIcon: const Icon(Icons.add_box),
            label: l10n.navPost,
          ),
          NavigationDestination(
            icon: const Icon(Icons.info_outline),
            selectedIcon: const Icon(Icons.info),
            label: l10n.navInfo,
          ),
          NavigationDestination(
            icon: const Icon(Icons.person_outline),
            selectedIcon: const Icon(Icons.person),
            label: l10n.navProfile,
          ),
        ],
      ),
    );
  }

  void _showTenantSwitcher(
    BuildContext context,
    WidgetRef ref,
    String tenantName,
  ) {
    final l10n = AppLocalizations.of(context)!;
    AppBottomSheet.show(
      context,
      builder: (context) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l10n.tenantSwitcherTitle,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.sm),
          ListTile(
            leading: const Icon(Icons.place_outlined),
            title: Text(tenantName),
          ),
          const SizedBox(height: AppSpacing.sm),
          AppButton(
            label: l10n.tenantSwitcherChangeArea,
            variant: AppButtonVariant.secondary,
            onPressed: () {
              Navigator.of(context).pop();
              ref
                  .read(tenantBootstrapControllerProvider.notifier)
                  .switchTenant();
            },
          ),
        ],
      ),
    );
  }
}
