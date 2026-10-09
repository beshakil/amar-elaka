import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/tokens/app_spacing.dart';
import '../../../core/design/widgets/error_state.dart';
import '../../../core/design/widgets/network_photo.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';
import '../../feed/presentation/listing_format.dart';
import '../../store/data/store_models.dart';
import '../application/my_store_providers.dart';

/// Each product's stock (ADR 057): in stock, out of stock, or on order —
/// one tap, shown on the store page, the catalog and the WhatsApp export.
class StockScreen extends ConsumerWidget {
  const StockScreen({required this.storeId, super.key});

  final String storeId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final stock = ref.watch(stockProvider(storeId));
    return Scaffold(
      appBar: AppBar(title: Text(l10n.stockTitle)),
      body: switch (stock) {
        AsyncData(:final value) when value.items.isEmpty => Center(
          child: Text(l10n.stockEmpty),
        ),
        AsyncData(:final value) => ListView.separated(
          padding: const EdgeInsets.all(AppSpacing.md),
          itemCount: value.items.length + (value.nextCursor == null ? 0 : 1),
          separatorBuilder: (_, _) => const Divider(),
          itemBuilder: (context, i) {
            if (i == value.items.length) {
              return Center(
                child: OutlinedButton(
                  onPressed: () => unawaited(
                    ref.read(stockProvider(storeId).notifier).loadMore(),
                  ),
                  child: Text(l10n.storeLoadMore),
                ),
              );
            }
            return _ProductStock(
              storeId: storeId,
              product: value.items[i],
              saving: value.saving.contains(value.items[i].id),
            );
          },
        ),
        AsyncError() => ErrorState(
          title: l10n.myStoreLoadFailed,
          retryLabel: l10n.storeRetry,
          onRetry: () => ref.invalidate(stockProvider(storeId)),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _ProductStock extends ConsumerWidget {
  const _ProductStock({
    required this.storeId,
    required this.product,
    required this.saving,
  });

  final String storeId;
  final StoreProduct product;
  final bool saving;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final theme = Theme.of(context);
    return Column(
      key: ValueKey('stock-${product.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            SizedBox.square(
              dimension: 48,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: NetworkPhoto(url: product.thumbUrl, thumbhash: null),
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    product.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    ListingFormat.price(product.price, null, l10n, locale),
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
            if (saving)
              const SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.xs),
        SegmentedButton<String>(
          showSelectedIcon: false,
          segments: [
            ButtonSegment(value: 'in_stock', label: Text(l10n.stockInStock)),
            ButtonSegment(
              value: 'out_of_stock',
              label: Text(l10n.stockOutOfStock),
            ),
            ButtonSegment(value: 'on_order', label: Text(l10n.stockOnOrder)),
          ],
          selected: {product.stockStatus},
          onSelectionChanged: !product.canManage || saving
              ? null
              : (selected) async {
                  final messenger = ScaffoldMessenger.of(context);
                  try {
                    await ref
                        .read(stockProvider(storeId).notifier)
                        .setStock(product.id, selected.first);
                  } on AppException {
                    messenger.showSnackBar(
                      SnackBar(content: Text(l10n.stockFailed)),
                    );
                  }
                },
        ),
      ],
    );
  }
}
