import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/design/tokens/app_spacing.dart';
import '../../../../core/design/widgets/app_bottom_sheet.dart';
import '../../../../core/design/widgets/app_button.dart';
import '../../../../l10n/app_localizations.dart';
import '../../../post/application/post_editor.dart';
import '../../application/search_controller.dart';
import '../search_labels.dart';

/// The filter sheet, built from the answer's facets: every choice shows how
/// many results it leads to. It applies each tap at once (the results behind
/// it and the counts in it refresh), so the counts are never stale; the
/// button only closes it, saying how many results wait.
///
///  - category: the result's categories with their counts;
///  - price: ranges fitted to the prices in the results (ADR 040);
///  - the chosen category's top select-type fields, value by value.
abstract final class SearchFilterSheet {
  static Future<void> show(BuildContext context) => AppBottomSheet.show<void>(
    context,
    isScrollControlled: true,
    builder: (_) => const _FilterSheetBody(),
  );
}

class _FilterSheetBody extends ConsumerWidget {
  const _FilterSheetBody();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context)!;
    final locale = Localizations.localeOf(context).languageCode;
    final state = ref.watch(searchControllerProvider);
    final controller = ref.read(searchControllerProvider.notifier);
    final labels = SearchLabels(
      l10n,
      locale,
      ref.watch(postableCategoriesProvider).value ?? const [],
    );
    final request = state.request;
    final facets = state.result?.facets ?? SearchFacets.empty;
    final price = facets.price;
    final schema = labels.schemaOf(request.categorySlug);
    final height = MediaQuery.sizeOf(context).height;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: height * 0.85),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  l10n.searchFilters,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              if (request.hasFilters)
                TextButton(
                  key: const ValueKey('search-filter-clear'),
                  onPressed: controller.clearFilters,
                  child: Text(l10n.searchFilterClear),
                ),
            ],
          ),
          if (state.loading) const LinearProgressIndicator(minHeight: 2),
          const SizedBox(height: AppSpacing.sm),
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _Section(
                    title: l10n.searchFilterCategory,
                    children: [
                      ChoiceChip(
                        key: const ValueKey('search-filter-category-all'),
                        label: Text(l10n.searchFilterAllCategories),
                        selected: request.categorySlug == null,
                        onSelected: (_) => controller.setCategory(null),
                      ),
                      // The chosen one stays even when this answer has no count for it.
                      if (request.categorySlug != null &&
                          !facets.categories.any(
                            (c) => c.slug == request.categorySlug,
                          ))
                        ChoiceChip(
                          label: Text(
                            labels.categoryName(request.categorySlug!),
                          ),
                          selected: true,
                          onSelected: (_) => controller.setCategory(null),
                        ),
                      for (final c in facets.categories)
                        ChoiceChip(
                          key: ValueKey('search-filter-category-${c.slug}'),
                          label: Text(
                            l10n.searchFacetCount(
                              labels.categoryName(c.slug),
                              labels.count(c.count),
                            ),
                          ),
                          selected: request.categorySlug == c.slug,
                          onSelected: (on) =>
                              controller.setCategory(on ? c.slug : null),
                        ),
                    ],
                  ),
                  if (price != null && price.buckets.isNotEmpty)
                    _Section(
                      title: l10n.searchFilterPrice,
                      children: [
                        ChoiceChip(
                          key: const ValueKey('search-filter-price-any'),
                          label: Text(l10n.searchFilterAnyPrice),
                          selected:
                              request.priceMin == null &&
                              request.priceMax == null,
                          onSelected: (_) => controller.setPrice(null, null),
                        ),
                        for (final (i, b) in price.buckets.indexed)
                          ChoiceChip(
                            key: ValueKey('search-filter-price-$i'),
                            label: Text(
                              l10n.searchFacetCount(
                                labels.priceRange(b.min, b.max),
                                labels.count(b.count),
                              ),
                            ),
                            selected:
                                request.priceMin == b.min &&
                                request.priceMax == b.max,
                            onSelected: (on) => on
                                ? controller.setPrice(b.min, b.max)
                                : controller.setPrice(null, null),
                          ),
                      ],
                    ),
                  if (request.categorySlug != null)
                    for (final entry in facets.fields.entries)
                      if (entry.value case final ValuesFacet values)
                        _Section(
                          title: schema?.label(entry.key, locale) ?? entry.key,
                          children: [
                            for (final v in values.values)
                              FilterChip(
                                key: ValueKey(
                                  'search-filter-field-${entry.key}-${v.value}',
                                ),
                                label: Text(
                                  l10n.searchFacetCount(
                                    schema?.optionLabel(
                                          entry.key,
                                          v.value,
                                          locale,
                                        ) ??
                                        v.value,
                                    labels.count(v.count),
                                  ),
                                ),
                                selected:
                                    request.fieldValues[entry.key]?.contains(
                                      v.value,
                                    ) ??
                                    false,
                                onSelected: (_) => controller.toggleFieldValue(
                                  entry.key,
                                  v.value,
                                ),
                              ),
                          ],
                        ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          AppButton(
            key: const ValueKey('search-filter-show'),
            label: l10n.searchFilterShow(
              labels.count(state.result?.totalHits ?? 0),
            ),
            isLoading: state.loading,
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: AppSpacing.md),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: AppSpacing.xs),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.xs,
          children: children,
        ),
      ],
    ),
  );
}
