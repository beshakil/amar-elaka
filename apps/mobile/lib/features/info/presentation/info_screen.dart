import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../application/info_engine_providers.dart';
import '../application/info_providers.dart';

/// The Info tab (ADR 064): the local information services. Emergency first
/// — it opens with no network — then every info engine service (ADR 065).
/// The area team also sees the price entries.
/// `AppShell` provides the shared app bar/bottom nav; this is body content only.
class InfoScreen extends ConsumerWidget {
  const InfoScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    final isTeam = ref.watch(isAreaTeamProvider);
    final agri = ref.watch(agriEnabledProvider).value ?? false;
    _HubTile tile(
      IconData icon,
      String title,
      String subtitle,
      String path, {
      Color? color,
    }) => _HubTile(
      icon: icon,
      iconColor: color ?? colors.primary,
      title: title,
      subtitle: subtitle,
      onTap: () => context.push(path),
    );
    final tiles = [
      tile(
        Icons.emergency_outlined,
        l10n.infoHubEmergencyTitle,
        l10n.infoHubEmergencySubtitle,
        RoutePaths.emergency,
        color: colors.error,
      ),
      tile(
        Icons.bloodtype_outlined,
        l10n.infoHubBloodTitle,
        l10n.infoHubBloodSubtitle,
        RoutePaths.blood,
        color: colors.error,
      ),
      tile(
        Icons.power_off_outlined,
        l10n.infoHubOutagesTitle,
        l10n.infoHubOutagesSubtitle,
        RoutePaths.outages,
      ),
      tile(
        Icons.mosque_outlined,
        l10n.infoHubPrayerTitle,
        l10n.infoHubPrayerSubtitle,
        RoutePaths.prayer,
      ),
      tile(
        Icons.storefront_outlined,
        l10n.infoHubBazarTitle,
        l10n.infoHubBazarSubtitle,
        RoutePaths.bazar,
      ),
      tile(
        Icons.directions_bus_outlined,
        l10n.infoHubTransportTitle,
        l10n.infoHubTransportSubtitle,
        RoutePaths.transport,
      ),
      tile(
        Icons.campaign_outlined,
        l10n.infoHubNoticesTitle,
        l10n.infoHubNoticesSubtitle,
        '${RoutePaths.notices}?category=local',
      ),
      tile(
        Icons.groups_outlined,
        l10n.infoHubCommunityTitle,
        l10n.infoHubCommunitySubtitle,
        '${RoutePaths.notices}?category=community',
      ),
      tile(
        Icons.travel_explore,
        l10n.infoHubLostFoundTitle,
        l10n.infoHubLostFoundSubtitle,
        RoutePaths.lostFound,
      ),
      tile(
        Icons.local_hospital_outlined,
        l10n.infoHubDirectoryTitle,
        l10n.infoHubDirectorySubtitle,
        RoutePaths.directory,
      ),
      tile(
        Icons.account_balance_outlined,
        l10n.infoHubGovTitle,
        l10n.infoHubGovSubtitle,
        RoutePaths.govServices,
      ),
      if (agri)
        tile(
          Icons.agriculture_outlined,
          l10n.infoHubAgriTitle,
          l10n.infoHubAgriSubtitle,
          RoutePaths.agri,
        ),
    ];
    return ListView(
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        for (final t in tiles)
          Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.sm),
            child: t,
          ),
        if (isTeam) ...[
          const SizedBox(height: AppSpacing.md),
          Text(
            l10n.infoHubTeamNote,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: AppSpacing.sm),
          _HubTile(
            icon: Icons.edit_note,
            iconColor: colors.primary,
            title: l10n.infoHubBazarEntry,
            onTap: () => context.push(RoutePaths.bazarEntry),
          ),
          if (agri) ...[
            const SizedBox(height: AppSpacing.sm),
            _HubTile(
              icon: Icons.edit_note,
              iconColor: colors.primary,
              title: l10n.agriEntry,
              onTap: () => context.push('${RoutePaths.bazarEntry}?board=agri'),
            ),
          ],
        ],
      ],
    );
  }
}

class _HubTile extends StatelessWidget {
  const _HubTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    required this.onTap,
    this.subtitle,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      onTap: onTap,
      padding: const EdgeInsets.all(AppSpacing.sm),
      child: ListTile(
        contentPadding: EdgeInsets.zero,
        leading: Icon(icon, color: iconColor, size: 32),
        title: Text(title, style: Theme.of(context).textTheme.titleMedium),
        subtitle: subtitle == null ? null : Text(subtitle!),
        trailing: const Icon(Icons.chevron_right),
      ),
    );
  }
}
