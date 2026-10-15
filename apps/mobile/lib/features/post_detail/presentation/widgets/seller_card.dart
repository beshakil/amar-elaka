import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_card.dart';
import '../../../../core/routing/route_paths.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../reviews/data/review_models.dart';
import '../../../reviews/presentation/widgets/review_widgets.dart';

/// Who sells it: name, member since, badges and their store.
class SellerCardView extends StatelessWidget {
  const SellerCardView({required this.seller, this.onComplain, super.key});

  final SellerCard seller;

  /// "অভিযোগ করুন" about the seller (ADR 063); null hides it (one's own post).
  final VoidCallback? onComplain;

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
            InkWell(
              key: const ValueKey('detail-store'),
              onTap: () => context.push(RoutePaths.storeFor(store.slug)),
              child: Row(
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
                  if (store.tier case final tier?) ...[
                    const SizedBox(width: AppSpacing.xs),
                    SellerTierBadge(tier: sellerTierOf(tier), dense: true),
                  ],
                  const Icon(Icons.chevron_right, size: 20),
                ],
              ),
            ),
          ],
          if (onComplain != null)
            Align(
              alignment: AlignmentDirectional.centerEnd,
              child: TextButton.icon(
                key: const ValueKey('detail-seller-complain'),
                onPressed: onComplain,
                icon: const Icon(Icons.report_outlined, size: 18),
                label: Text(l10n.complaintAction),
              ),
            ),
        ],
      ),
    );
  }

  static String? _badge(String code, AppLocalizations l10n) => switch (code) {
    'trusted' => l10n.detailBadgeTrusted,
    'phone_verified' => l10n.detailBadgePhoneVerified,
    'identity_checked' => l10n.detailBadgeIdentityChecked,
    'verified_store' => l10n.detailBadgeVerifiedStore,
    _ => null,
  };
}
