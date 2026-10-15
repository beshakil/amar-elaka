import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/design/tokens/app_radii.dart';
import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/network_photo.dart';
import '../../../../core/dynamic_form/bn_numerals.dart';
import '../../../../l10n/app_localizations.dart';
import '../../data/review_models.dart';

/// "১২ মার্চ ২০২৬" / "12 Mar 2026", in the reader's digits.
String reviewDate(DateTime at, String locale) =>
    localizeDigits(DateFormat.yMMMd(locale).format(at.toLocal()), locale);

/// The seller score as a badge (ADR 061): a word, never the number. No
/// badge for [SellerTier.none]; "new" until a store has enough reviews.
class SellerTierBadge extends StatelessWidget {
  const SellerTierBadge({required this.tier, this.dense = false, super.key});

  final SellerTier tier;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    if (tier == SellerTier.none) return const SizedBox.shrink();
    final l10n = AppLocalizations.of(context)!;
    final scheme = Theme.of(context).colorScheme;
    final (label, icon, color) = switch (tier) {
      SellerTier.top => (
        l10n.tierTop,
        Icons.workspace_premium,
        scheme.secondary,
      ),
      SellerTier.trusted => (
        l10n.tierTrusted,
        Icons.verified_outlined,
        scheme.primary,
      ),
      SellerTier.good => (
        l10n.tierGood,
        Icons.thumb_up_alt_outlined,
        scheme.primary,
      ),
      _ => (l10n.tierNew, Icons.fiber_new_outlined, scheme.onSurfaceVariant),
    };
    return Tooltip(
      message: l10n.tierExplain,
      child: Container(
        key: ValueKey('seller-tier-${tier.name}'),
        padding: EdgeInsets.symmetric(
          horizontal: dense ? AppSpacing.xs : AppSpacing.sm,
          vertical: AppSpacing.xxs,
        ),
        decoration: BoxDecoration(
          border: Border.all(color: color),
          borderRadius: AppRadii.fullRadius,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: dense ? 14 : 16, color: color),
            const SizedBox(width: AppSpacing.xxs),
            Text(
              label,
              style:
                  (dense
                          ? Theme.of(context).textTheme.labelSmall
                          : Theme.of(context).textTheme.labelMedium)
                      ?.copyWith(color: color),
            ),
          ],
        ),
      ),
    );
  }
}

/// Stars, shown (and, with [onChanged], chosen — each star a 48dp target).
class StarRating extends StatelessWidget {
  const StarRating({
    required this.rating,
    this.size = 18,
    this.onChanged,
    super.key,
  });

  final num rating;
  final double size;
  final ValueChanged<int>? onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final color = Theme.of(context).colorScheme.secondary;
    return Semantics(
      label: l10n.reviewStars(localizeDigits('$rating', locale)),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (var star = 1; star <= 5; star++)
            onChanged == null
                ? Icon(_icon(star), size: size, color: color)
                : IconButton(
                    key: ValueKey('star-$star'),
                    tooltip: l10n.reviewStars(localizeDigits('$star', locale)),
                    iconSize: size,
                    onPressed: () => onChanged!(star),
                    icon: Icon(_icon(star), color: color),
                  ),
        ],
      ),
    );
  }

  IconData _icon(int star) => rating >= star
      ? Icons.star_rounded
      : rating >= star - 0.5
      ? Icons.star_half_rounded
      : Icons.star_outline_rounded;
}

/// The store's rating at a glance: average, count, the stars per level, the tier.
class ReviewSummaryCard extends StatelessWidget {
  const ReviewSummaryCard({required this.summary, super.key});

  final ReviewSummary summary;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final average = summary.average;
    return Row(
      key: const ValueKey('review-summary'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Column(
          children: [
            Text(
              average == null
                  ? '–'
                  : localizeDigits(average.toStringAsFixed(1), locale),
              style: theme.textTheme.displaySmall,
            ),
            StarRating(rating: average ?? 0, size: 16),
            const SizedBox(height: AppSpacing.xxs),
            Text(
              l10n.reviewsCount(localizeDigits('${summary.count}', locale)),
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
        const SizedBox(width: AppSpacing.lg),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var star = 5; star >= 1; star--)
                Row(
                  children: [
                    SizedBox(
                      width: AppSpacing.md,
                      child: Text(
                        localizeDigits('$star', locale),
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                    Expanded(
                      child: LinearProgressIndicator(
                        value: summary.count == 0
                            ? 0
                            : (summary.histogram[star] ?? 0) / summary.count,
                        minHeight: 6,
                        borderRadius: AppRadii.fullRadius,
                      ),
                    ),
                  ],
                ),
              const SizedBox(height: AppSpacing.sm),
              SellerTierBadge(tier: summary.tier),
            ],
          ),
        ),
      ],
    );
  }
}

/// One review: who (or "former member"), stars, when, the text (long
/// Bengali wraps), photos, the store's reply; and the actions the reader
/// has — the store replies, anyone else reports. Nobody deletes.
class ReviewCard extends StatelessWidget {
  const ReviewCard({
    required this.review,
    this.onReply,
    this.onReport,
    this.onOpenPhoto,
    super.key,
  });

  final StoreReview review;
  final VoidCallback? onReply;
  final VoidCallback? onReport;
  final ValueChanged<ReviewPhoto>? onOpenPhoto;

  static const _photoSize = 72.0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final name = review.authorRemoved
        ? l10n.reviewFormerMember
        : (review.authorName ?? l10n.reviewMember);
    return Padding(
      key: ValueKey('review-${review.id}'),
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  name,
                  style: theme.textTheme.titleSmall,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (onReply != null || onReport != null)
                PopupMenuButton<String>(
                  key: ValueKey('review-menu-${review.id}'),
                  onSelected: (action) =>
                      action == 'reply' ? onReply?.call() : onReport?.call(),
                  itemBuilder: (_) => [
                    if (onReply != null)
                      PopupMenuItem(
                        value: 'reply',
                        child: Text(
                          review.response == null
                              ? l10n.reviewReply
                              : l10n.reviewEditReply,
                        ),
                      ),
                    if (onReport != null)
                      PopupMenuItem(
                        value: 'report',
                        child: Text(l10n.reviewReport),
                      ),
                  ],
                ),
            ],
          ),
          Wrap(
            spacing: AppSpacing.sm,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StarRating(rating: review.rating, size: 16),
              Text(
                reviewDate(review.createdAt, locale) +
                    (review.editedAt == null ? '' : ' · ${l10n.reviewEdited}'),
                style: theme.textTheme.bodySmall,
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    Icons.verified_user_outlined,
                    size: 14,
                    color: theme.colorScheme.primary,
                  ),
                  const SizedBox(width: AppSpacing.xxs),
                  Text(
                    l10n.reviewVerifiedContact,
                    style: theme.textTheme.labelSmall,
                  ),
                ],
              ),
            ],
          ),
          if (review.text case final text? when text.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(text, style: theme.textTheme.bodyMedium),
          ],
          if (review.photos.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.xs,
              children: [
                for (final p in review.photos)
                  InkWell(
                    onTap: onOpenPhoto == null ? null : () => onOpenPhoto!(p),
                    child: ClipRRect(
                      borderRadius: AppRadii.mdRadius,
                      child: SizedBox.square(
                        dimension: _photoSize,
                        child: NetworkPhoto(
                          url: p.thumbUrl,
                          thumbhash: p.thumbhash,
                          decodeWidth: _photoSize,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
          if (review.response case final reply?) ...[
            const SizedBox(height: AppSpacing.sm),
            Container(
              key: ValueKey('review-reply-${review.id}'),
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                borderRadius: AppRadii.mdRadius,
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    l10n.reviewStoreReply,
                    style: theme.textTheme.labelMedium,
                  ),
                  const SizedBox(height: AppSpacing.xxs),
                  Text(reply.text, style: theme.textTheme.bodyMedium),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// "Why are you reporting this?" — the reason and, optionally, a few words.
Future<({String reasonCode, String? details})?> showReviewReportSheet(
  BuildContext context,
) => showModalBottomSheet<({String reasonCode, String? details})>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  builder: (context) => const _ReportSheet(),
);

class _ReportSheet extends StatefulWidget {
  const _ReportSheet();

  @override
  State<_ReportSheet> createState() => _ReportSheetState();
}

class _ReportSheetState extends State<_ReportSheet> {
  String _reason = reviewReportReasons.first;
  final _details = TextEditingController();

  @override
  void dispose() {
    _details.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final labels = {
      'fake_review': l10n.reviewReportFake,
      'harassment': l10n.reviewReportHarassment,
      'spam': l10n.reviewReportSpam,
      'other': l10n.reviewReportOther,
    };
    return Padding(
      padding: EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        MediaQuery.viewInsetsOf(context).bottom + AppSpacing.md,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l10n.reviewReportTitle,
            style: Theme.of(context).textTheme.titleMedium,
          ),
          RadioGroup<String>(
            groupValue: _reason,
            onChanged: (v) => setState(() => _reason = v ?? _reason),
            child: Column(
              children: [
                for (final code in reviewReportReasons)
                  RadioListTile<String>(
                    key: ValueKey('review-report-$code'),
                    value: code,
                    title: Text(labels[code]!),
                  ),
              ],
            ),
          ),
          TextField(
            controller: _details,
            maxLines: 3,
            decoration: InputDecoration(hintText: l10n.reviewReportDetailsHint),
          ),
          const SizedBox(height: AppSpacing.md),
          FilledButton(
            key: const ValueKey('review-report-send'),
            onPressed: () => Navigator.pop(context, (
              reasonCode: _reason,
              details: _details.text,
            )),
            child: Text(l10n.reviewReportSend),
          ),
        ],
      ),
    );
  }
}
