import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_card.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../l10n/app_localizations.dart';
import '../listing_format.dart';

/// A post in the feed (and in "similar posts"): the cover's thumbhash then
/// its card-size photo, title, price in the reader's numerals, area and
/// distance, badges (boosted, verified store, sold…) and the saved heart.
///
/// Built for long lists on 2 GB phones: a fixed photo size decoded at that
/// size, no intrinsic layout, and its own repaint boundary so a heart tap or
/// an image fading in repaints this card only.
class PostListingCard extends StatelessWidget {
  const PostListingCard({
    required this.card,
    super.key,
    this.onTap,
    this.onToggleSaved,
  });

  final FeedPostCard card;
  final VoidCallback? onTap;

  /// Null hides the heart (e.g. the viewer's own post).
  final VoidCallback? onToggleSaved;

  static const photoSize = 112.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final text = theme.textTheme;
    final muted = text.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final free = card.badges.contains('free');
    final meta = [
      ?card.area?.of(locale),
      ?ListingFormat.distance(card.distanceMeters, l10n, locale),
    ].join(' · ');
    final badges = [
      if (card.isSold) l10n.postCardSold,
      for (final code in card.badges) ?ListingFormat.badge(code, l10n),
    ];

    return RepaintBoundary(
      child: AppCard(
        onTap: onTap,
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Cover(card: card, size: photoSize),
            const SizedBox(width: AppSpacing.sm + AppSpacing.xs),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: Text(
                          card.title,
                          style: text.titleMedium,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (onToggleSaved != null)
                        _SaveHeart(
                          saved: card.isSaved,
                          onPressed: onToggleSaved!,
                        ),
                    ],
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    ListingFormat.price(
                      card.price,
                      null,
                      l10n,
                      locale,
                      free: free,
                    ),
                    style: text.titleMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  if (meta.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      meta,
                      style: muted,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                  if (badges.isNotEmpty) ...[
                    const SizedBox(height: AppSpacing.xs),
                    Wrap(
                      spacing: AppSpacing.xs,
                      runSpacing: AppSpacing.xs,
                      children: [for (final label in badges) _Badge(label)],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Cover extends StatelessWidget {
  const _Cover({required this.card, required this.size});

  final FeedPostCard card;
  final double size;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    return ClipRRect(
      borderRadius: AppRadii.mdRadius,
      child: SizedBox.square(
        dimension: size,
        child: Stack(
          fit: StackFit.expand,
          children: [
            NetworkPhoto(
              url: card.cover?.url,
              thumbhash: card.cover?.thumbhash,
              decodeWidth: size,
            ),
            if (card.isSold)
              Align(
                alignment: Alignment.bottomCenter,
                child: Container(
                  width: double.infinity,
                  color: theme.colorScheme.inverseSurface.withValues(
                    alpha: 0.85,
                  ),
                  padding: const EdgeInsets.symmetric(vertical: AppSpacing.xxs),
                  child: Text(
                    l10n.postCardSold,
                    textAlign: TextAlign.center,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: theme.colorScheme.onInverseSurface,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _SaveHeart extends StatelessWidget {
  const _SaveHeart({required this.saved, required this.onPressed});

  final bool saved;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final colors = Theme.of(context).colorScheme;
    return IconButton(
      key: const ValueKey('feed-card-heart'),
      visualDensity: VisualDensity.compact,
      tooltip: saved ? l10n.feedUnsave : l10n.feedSave,
      isSelected: saved,
      onPressed: onPressed,
      icon: Icon(Icons.favorite_border, color: colors.onSurfaceVariant),
      selectedIcon: Icon(Icons.favorite, color: colors.error),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.colorScheme.secondaryContainer,
        borderRadius: AppRadii.smRadius,
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.xs + AppSpacing.xxs,
          vertical: AppSpacing.xxs,
        ),
        child: Text(
          label,
          style: theme.textTheme.labelSmall?.copyWith(
            color: theme.colorScheme.onSecondaryContainer,
          ),
        ),
      ),
    );
  }
}
