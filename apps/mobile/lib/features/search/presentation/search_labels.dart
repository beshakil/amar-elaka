import 'package:amar_elaka_api/amar_elaka_api.dart';

import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/dynamic_form/field_schema.dart';
import '../../../l10n/app_localizations.dart';
import '../domain/search_request.dart';

/// How search's filters read, the same in the chip row, the filter sheet
/// and the empty state: category names from the catalog, option labels from
/// the category's schema, prices in the reader's numerals.
class SearchLabels {
  SearchLabels(this.l10n, this.locale, List<CatalogCategory> categories)
    : _categories = {for (final c in categories) c.slug: c};

  final AppLocalizations l10n;
  final String locale;
  final Map<String, CatalogCategory> _categories;

  CatalogCategory? category(String? slug) => _categories[slug];

  String categoryName(String slug) =>
      _categories[slug]?.name.of(locale) ?? slug;

  CategoryFieldSchema? schemaOf(String? slug) {
    final raw = _categories[slug]?.fieldSchema;
    return raw == null ? null : CategoryFieldSchema.fromJson(raw);
  }

  String count(int n) => localizeDigits('$n', locale);

  /// "৳ ১০,০০০–২০,০০০", "৳ ৪০,০০০+".
  String priceRange(String? min, String? max) {
    final from = formatMoney(min ?? '0.00', locale);
    return max == null
        ? l10n.searchPriceFrom(from)
        : l10n.searchPriceRange(from, formatMoney(max, locale));
  }

  /// "অবস্থা: ব্যবহৃত", or the option code when the schema doesn't know it.
  String fieldValues(String? categorySlug, String field, List<String> values) {
    final schema = schemaOf(categorySlug);
    final label = schema?.label(field, locale) ?? field;
    final options = [
      for (final v in values) schema?.optionLabel(field, v, locale) ?? v,
    ].join(', ');
    return '$label: $options';
  }

  String filter(ActiveFilter filter, SearchRequest request) => switch (filter) {
    CategoryFilter(:final slug) => categoryName(slug),
    PriceFilter(:final min, :final max) => priceRange(min, max),
    FieldFilter(:final field, :final values) => fieldValues(
      request.categorySlug,
      field,
      values,
    ),
  };

  String sort(SearchSort sort) => switch (sort) {
    SearchSort.relevance => l10n.searchSortRelevance,
    SearchSort.newest => l10n.searchSortNewest,
    SearchSort.priceAsc => l10n.searchSortPriceAsc,
    SearchSort.priceDesc => l10n.searchSortPriceDesc,
    SearchSort.distance => l10n.searchSortDistance,
  };

  String frequency(AlertFrequency frequency) => switch (frequency) {
    AlertFrequency.instant => l10n.searchFrequencyInstant,
    AlertFrequency.daily => l10n.searchFrequencyDaily,
    AlertFrequency.off => l10n.searchFrequencyOff,
  };

  /// Kilometres without a trailing ".0", in the reader's numerals.
  String km(double km) => localizeDigits(
    km == km.roundToDouble() ? '${km.round()}' : '$km',
    locale,
  );
}
