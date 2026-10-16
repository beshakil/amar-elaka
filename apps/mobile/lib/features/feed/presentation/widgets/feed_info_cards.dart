import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_card.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../core/platform/external_apps.dart';
import '../../../../core/routing/route_paths.dart';
import '../../../info/data/info_models.dart' show bloodGroupSymbol;
import '../../../info/presentation/info_labels.dart';
import '../../../../l10n/app_localizations.dart';
import '../listing_format.dart';

/// The bazar prices: a compact table, one row per commodity, with today's
/// arrow against yesterday; a stale card says it isn't today's (ADR 064).
class BazarPricesCard extends StatelessWidget {
  const BazarPricesCard({required this.card, super.key});

  final FeedBazarCard card;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final text = Theme.of(context).textTheme;
    final colors = Theme.of(context).colorScheme;
    return RepaintBoundary(
      child: AppCard(
        onTap: () => context.push(RoutePaths.bazar),
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.storefront_outlined, size: 20),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(l10n.feedBazarTitle, style: text.titleMedium),
                ),
                const Icon(Icons.chevron_right, size: 20),
              ],
            ),
            if (card.isStale)
              Text(
                l10n.feedBazarStale(InfoLabels.day(card.date, locale)),
                style: text.bodySmall?.copyWith(color: colors.tertiary),
              ),
            const SizedBox(height: AppSpacing.sm),
            for (final item in card.items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(item.name.of(locale) ?? item.commodity),
                    ),
                    Text(
                      l10n.feedBazarPerUnit(
                        l10n.feedBazarRange(
                          formatMoney(item.minPrice, locale),
                          formatMoney(item.maxPrice, locale),
                        ),
                        _unit(item.unit, l10n),
                      ),
                      style: text.bodyMedium?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    SizedBox(
                      width: 20,
                      child: switch (item.direction) {
                        'up' => Icon(
                          Icons.arrow_upward,
                          size: 16,
                          color: colors.error,
                          semanticLabel: l10n.bazarUp,
                        ),
                        'down' => Icon(
                          Icons.arrow_downward,
                          size: 16,
                          color: Colors.green.shade700,
                          semanticLabel: l10n.bazarDown,
                        ),
                        _ => null,
                      },
                    ),
                  ],
                ),
              ),
            if (card.sponsor case final sponsor?)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Text(
                  l10n.bazarSponsoredBy(sponsor.name.of(locale) ?? ''),
                  style: text.labelSmall?.copyWith(color: colors.primary),
                ),
              ),
          ],
        ),
      ),
    );
  }

  static String _unit(String code, AppLocalizations l10n) =>
      InfoLabels.unit(code, l10n);
}

/// Urgent blood requests nearby: counts and groups only — the requests
/// themselves are for signed-in members (ADR 064).
class BloodRequestsCard extends StatelessWidget {
  const BloodRequestsCard({required this.card, super.key});

  final FeedBloodCard card;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final colors = Theme.of(context).colorScheme;
    final text = Theme.of(context).textTheme;
    return RepaintBoundary(
      child: AppCard(
        onTap: () => context.push(RoutePaths.blood),
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          children: [
            Icon(Icons.bloodtype, color: colors.error, size: 32),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    l10n.feedBloodTitle,
                    style: text.titleMedium?.copyWith(color: colors.error),
                  ),
                  Text(
                    l10n.feedBloodBody(
                      localizeDigits('${card.openRequests}', locale),
                      card.groups.map(bloodGroupSymbol).join(', '),
                    ),
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: () => context.push(RoutePaths.blood),
              child: Text(l10n.feedBloodAction),
            ),
          ],
        ),
      ),
    );
  }
}

/// The emergency shortcut: one tap dials the hotline.
class EmergencyCard extends ConsumerWidget {
  const EmergencyCard({required this.card, super.key});

  final FeedEmergencyCard card;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final colors = Theme.of(context).colorScheme;
    return RepaintBoundary(
      child: AppCard(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Icon(Icons.emergency_outlined, size: 20, color: colors.error),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    l10n.feedEmergencyTitle,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                TextButton(
                  onPressed: () => context.push(RoutePaths.emergency),
                  child: Text(l10n.emergencyAllNumbers),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.sm,
              children: [
                for (final hotline in card.hotlines)
                  ActionChip(
                    avatar: const Icon(Icons.call, size: 18),
                    label: Text(
                      '${hotline.name.of(locale) ?? hotline.serviceType} '
                      '${localizeDigits(hotline.dial, locale)}',
                    ),
                    tooltip: l10n.feedEmergencyCall(
                      hotline.name.of(locale) ?? hotline.dial,
                    ),
                    onPressed: () => ref
                        .read(externalAppsProvider)
                        .open(Uri(scheme: 'tel', path: hotline.dial)),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// A nearby store: its cover, name, verified mark and distance.
class StoreListingCard extends StatelessWidget {
  const StoreListingCard({required this.card, super.key});

  final FeedStoreCard card;

  static const photoSize = 56.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    return RepaintBoundary(
      child: AppCard(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Row(
          children: [
            ClipRRect(
              borderRadius: AppRadii.mdRadius,
              child: SizedBox.square(
                dimension: photoSize,
                child: NetworkPhoto(
                  url: card.cover?.url,
                  thumbhash: card.cover?.thumbhash,
                  decodeWidth: photoSize,
                ),
              ),
            ),
            const SizedBox(width: AppSpacing.sm + AppSpacing.xs),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          card.name.of(locale) ?? card.slug,
                          style: theme.textTheme.titleSmall,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (card.isVerified) ...[
                        const SizedBox(width: AppSpacing.xs),
                        Icon(
                          Icons.verified,
                          size: 16,
                          color: theme.colorScheme.primary,
                          semanticLabel: l10n.feedBadgeVerifiedStore,
                        ),
                      ],
                    ],
                  ),
                  Text(
                    [
                      l10n.feedStoreLabel,
                      ?ListingFormat.distance(
                        card.distanceMeters,
                        l10n,
                        locale,
                      ),
                    ].join(' · '),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A landmark near the viewer.
class LandmarkListingCard extends StatelessWidget {
  const LandmarkListingCard({required this.card, super.key});

  final FeedLandmarkCard card;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    return RepaintBoundary(
      child: AppCard(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.place_outlined),
          title: Text(card.name.of(locale) ?? card.slug),
          subtitle: Text(
            ListingFormat.distance(card.distanceMeters, l10n, locale) ?? '',
          ),
        ),
      ),
    );
  }
}
