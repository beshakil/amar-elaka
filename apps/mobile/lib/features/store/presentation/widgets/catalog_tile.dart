import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_card.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../feed/presentation/listing_format.dart';

/// A product in a store's catalog grid (ADR 057): square photo, title,
/// price and its stock badge — the feed's own formatting and badges.
class CatalogTile extends StatelessWidget {
  const CatalogTile({required this.card, super.key, this.onTap});

  final FeedPostCard card;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final stock = [
      for (final code in card.badges)
        if (code == 'out_of_stock' || code == 'on_order')
          (code, ListingFormat.badge(code, l10n)!),
    ];
    return RepaintBoundary(
      child: AppCard(
        key: ValueKey('catalog-${card.id}'),
        onTap: onTap,
        padding: EdgeInsets.zero,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // The photo takes what the text leaves: no overflow at any text size.
            Expanded(
              child: ClipRRect(
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(AppRadii.md),
                ),
                child: NetworkPhoto(
                  url: card.cover?.url,
                  thumbhash: card.cover?.thumbhash,
                  semanticLabel: card.title,
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(AppSpacing.sm),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    card.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium,
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(
                    ListingFormat.price(
                      card.price,
                      null,
                      l10n,
                      locale,
                      free: card.badges.contains('free'),
                    ),
                    style: theme.textTheme.titleSmall?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  for (final (code, label) in stock)
                    Padding(
                      padding: const EdgeInsets.only(top: AppSpacing.xxs),
                      child: Text(
                        label,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: code == 'out_of_stock'
                              ? theme.colorScheme.error
                              : theme.colorScheme.tertiary,
                        ),
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
