import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../core/design/tokens/app_radii.dart';
import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/app_card.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/routing/route_paths.dart';
import '../../../l10n/app_localizations.dart';
import '../../feed/presentation/listing_format.dart';
import 'info_engine_labels.dart';
import 'info_labels.dart';

/// THE card of every info engine list and of the feed (ADR 065): type icon,
/// title, summary, badges in words, the time window, distance and — past
/// the type's window — "may be out of date". A tap opens the type's screen.
class InfoCardTile extends StatelessWidget {
  const InfoCardTile({
    required this.card,
    super.key,
    this.showType = false,
    this.interactive = true,
  });

  final InfoCard card;

  /// False inside the outage sheet (it is already open).
  final bool interactive;

  /// On the feed: name the type above the title.
  final bool showType;

  static IconData iconOf(String type) => switch (type) {
    'outage' || 'outage_report' => Icons.power_off_outlined,
    'notice' => Icons.campaign_outlined,
    'lost_found' => Icons.travel_explore,
    'transport' => Icons.directions_bus_outlined,
    'gov_service' => Icons.account_balance_outlined,
    'directory' => Icons.local_hospital_outlined,
    _ => Icons.info_outline,
  };

  static void open(BuildContext context, InfoCard card) {
    switch (card.type) {
      case 'notice':
        context.push(RoutePaths.noticeFor(card.id));
      case 'lost_found':
        context.push(RoutePaths.lostFoundFor(card.id));
      case 'transport':
        context.push(RoutePaths.routeFor(card.id));
      case 'gov_service':
        context.push(RoutePaths.govServiceFor(card.id));
      case 'directory':
        context.push(RoutePaths.placeFor(card.id));
      default:
        showModalBottomSheet<void>(
          context: context,
          builder: (_) => _OutageSheet(card: card),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final urgent = card.has('ongoing') || card.has('janaza');
    final badges = [
      for (final b in card.badges) ?InfoEngineLabels.badge(b, l10n),
    ];
    final when = _when(l10n, locale);
    final meta = [
      ?when,
      ?ListingFormat.distance(card.distanceMeters, l10n, locale),
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: AppCard(
        onTap: interactive ? () => open(context, card) : null,
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (card.imageUrl != null)
              ClipRRect(
                borderRadius: AppRadii.mdRadius,
                child: SizedBox.square(
                  dimension: 64,
                  child: NetworkPhoto(
                    url: card.imageUrl,
                    thumbhash: card.imageThumbhash,
                    decodeWidth: 64,
                  ),
                ),
              )
            else
              CircleAvatar(
                backgroundColor: urgent
                    ? colors.errorContainer
                    : colors.secondaryContainer,
                child: Icon(
                  iconOf(card.type),
                  color: urgent
                      ? colors.onErrorContainer
                      : colors.onSecondaryContainer,
                ),
              ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (showType)
                    Text(
                      InfoEngineLabels.type(card.type, l10n),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: colors.primary,
                      ),
                    ),
                  Text(
                    card.title.of(locale) ?? '',
                    style: theme.textTheme.titleSmall,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  if (_summary(l10n) case final summary?)
                    Text(
                      summary,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall,
                    ),
                  if (meta.isNotEmpty)
                    Text(
                      meta,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  const SizedBox(height: AppSpacing.xxs),
                  Wrap(
                    spacing: AppSpacing.xs,
                    runSpacing: AppSpacing.xxs,
                    children: [
                      for (final b in badges) _Badge(text: b),
                      if (card.isStale)
                        _Badge(
                          text: l10n.infoStale,
                          color: colors.tertiaryContainer,
                          icon: Icons.history,
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String? _summary(AppLocalizations l10n) => card.type == 'outage_report'
      ? l10n.outageReportedBy(card.summary ?? '')
      : card.summary;

  String? _when(AppLocalizations l10n, String locale) {
    final from = card.startsAt;
    final to = card.endsAt;
    if (card.type == 'outage' && from != null && to != null) {
      return l10n.infoWindow(
        InfoLabels.moment(from, locale),
        InfoLabels.moment(to, locale),
      );
    }
    if (card.type == 'lost_found' && from != null) {
      return l10n.lfLastSeenAt(InfoLabels.moment(from, locale));
    }
    if (card.type == 'notice' && from != null) {
      return InfoLabels.moment(from, locale);
    }
    final updated = card.updatedAt;
    if (updated != null &&
        const {'transport', 'gov_service', 'directory'}.contains(card.type)) {
      return l10n.infoUpdated(InfoLabels.day(_iso(updated), locale));
    }
    return null;
  }

  static String _iso(DateTime d) => d.toIso8601String().substring(0, 10);
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, this.color, this.icon});

  final String text;
  final Color? color;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.xs,
        vertical: AppSpacing.xxs,
      ),
      decoration: BoxDecoration(
        color: color ?? colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppSpacing.xs),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 12),
            const SizedBox(width: AppSpacing.xxs),
          ],
          Text(text, style: Theme.of(context).textTheme.labelSmall),
        ],
      ),
    );
  }
}

/// An outage has no screen of its own: its card says it all, in a sheet.
class _OutageSheet extends StatelessWidget {
  const _OutageSheet({required this.card});

  final InfoCard card;

  @override
  Widget build(BuildContext context) => SafeArea(
    child: Padding(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: InfoCardTile(card: card, interactive: false),
    ),
  );
}
