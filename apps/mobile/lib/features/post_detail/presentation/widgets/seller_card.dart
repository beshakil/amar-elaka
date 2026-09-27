import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_card.dart';
import '../../../../l10n/app_localizations.dart';

/// Who sells it: name, member since, badges and their store.
class SellerCardView extends StatelessWidget {
  const SellerCardView({required this.seller, super.key});

  final SellerCard seller;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    final since = seller.memberSince;
    final store = seller.store;
    return AppCard(
      key: const ValueKey('detail-seller'),
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.detailSeller, style: theme.textTheme.labelLarge),
          const SizedBox(height: AppSpacing.sm),
          Row(
            children: [
              CircleAvatar(
                child: Text(
                  (seller.name ?? '?').characters.first,
                  style: theme.textTheme.titleMedium,
                ),
              ),
              const SizedBox(width: AppSpacing.sm + AppSpacing.xs),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      seller.name ?? '—',
                      style: theme.textTheme.titleMedium,
                    ),
                    if (since != null)
                      Text(
                        l10n.detailMemberSince(
                          DateFormat.yMMMM(locale).format(since.toLocal()),
                        ),
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
          if (seller.badges.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.sm),
            Wrap(
              spacing: AppSpacing.sm,
              runSpacing: AppSpacing.xs,
              children: [
                for (final badge in seller.badges)
                  if (_badge(badge, l10n) case final label?)
                    Chip(
                      avatar: Icon(
                        Icons.verified_outlined,
                        size: 16,
                        color: theme.colorScheme.primary,
                      ),
                      label: Text(label),
                      visualDensity: VisualDensity.compact,
                    ),
              ],
            ),
          ],
          if (store != null) ...[
            const Divider(height: AppSpacing.lg),
            Row(
              key: const ValueKey('detail-store'),
              children: [
                const Icon(Icons.storefront_outlined, size: 20),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    store.name.of(locale) ?? store.slug,
                    style: theme.textTheme.titleSmall,
                  ),
                ),
                if (store.verified)
                  Icon(
                    Icons.verified,
                    size: 18,
                    color: theme.colorScheme.primary,
                    semanticLabel: l10n.detailBadgeVerifiedStore,
                  ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  static String? _badge(String code, AppLocalizations l10n) => switch (code) {
    'trusted' => l10n.detailBadgeTrusted,
    'phone_verified' => l10n.detailBadgePhoneVerified,
    'verified_store' => l10n.detailBadgeVerifiedStore,
    _ => null,
  };
}
