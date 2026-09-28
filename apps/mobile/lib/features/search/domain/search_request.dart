import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';

/// GET /search's `sort` (apps/api/src/search/query/filter-builder.ts).
enum SearchSort {
  relevance('relevance'),
  newest('newest'),
  priceAsc('price_asc'),
  priceDesc('price_desc'),
  distance('distance');

  const SearchSort(this.api);

  final String api;
}

/// One thing narrowing the results, as the empty state and the chip row
/// offer to remove it.
sealed class ActiveFilter {
  const ActiveFilter();
}

final class CategoryFilter extends ActiveFilter {
  const CategoryFilter(this.slug);

  final String slug;
}

final class PriceFilter extends ActiveFilter {
  const PriceFilter(this.min, this.max);

  final String? min;
  final String? max;
}

final class FieldFilter extends ActiveFilter {
  const FieldFilter(this.field, this.values);

  final String field;
  final List<String> values;
}

/// A search as the viewer asked for it: text, category, field values, price
/// range, sort and radius. Immutable; each change is a new request (and a
/// new first page). The same shape becomes a saved search ([toSavedFilters]).
class SearchRequest {
  const SearchRequest({
    this.q = '',
    this.categorySlug,
    this.fieldValues = const {},
    this.priceMin,
    this.priceMax,
    this.sort = SearchSort.relevance,
    this.radiusKm,
  });

  /// As typed, in any script: Bengali, Banglish or English.
  final String q;
  final String? categorySlug;

  /// Select-type field → chosen option codes (an `in` filter; `eq` for bools).
  final Map<String, List<String>> fieldValues;

  /// Money strings: min inclusive, max exclusive (a price facet's bounds).
  final String? priceMin;
  final String? priceMax;
  final SearchSort sort;

  /// Null: the area's own radius (scope `area`). Set: scope `nearby`.
  final double? radiusKm;

  String get text => q.trim();

  List<ActiveFilter> get activeFilters => [
    if (categorySlug != null) CategoryFilter(categorySlug!),
    if (priceMin != null || priceMax != null) PriceFilter(priceMin, priceMax),
    for (final entry in fieldValues.entries)
      if (entry.value.isNotEmpty) FieldFilter(entry.key, entry.value),
  ];

  bool get hasFilters => activeFilters.isNotEmpty;

  SearchRequest _copy({
    String? q,
    String? Function()? categorySlug,
    Map<String, List<String>>? fieldValues,
    String? Function()? priceMin,
    String? Function()? priceMax,
    SearchSort? sort,
    double? Function()? radiusKm,
  }) => SearchRequest(
    q: q ?? this.q,
    categorySlug: categorySlug != null ? categorySlug() : this.categorySlug,
    fieldValues: fieldValues ?? this.fieldValues,
    priceMin: priceMin != null ? priceMin() : this.priceMin,
    priceMax: priceMax != null ? priceMax() : this.priceMax,
    sort: sort ?? this.sort,
    radiusKm: radiusKm != null ? radiusKm() : this.radiusKm,
  );

  SearchRequest withText(String q) => _copy(q: q);

  /// A new category drops the old one's field values.
  SearchRequest withCategory(String? slug) =>
      _copy(categorySlug: () => slug, fieldValues: const {});

  SearchRequest withPrice(String? min, String? max) =>
      _copy(priceMin: () => min, priceMax: () => max);

  SearchRequest withSort(SearchSort sort) => _copy(sort: sort);

  SearchRequest withRadius(double km) => _copy(radiusKm: () => km);

  /// Adds or removes one option of a select-type field.
  SearchRequest toggleFieldValue(String field, String value) {
    final current = fieldValues[field] ?? const [];
    final next = current.contains(value)
        ? [
            for (final v in current)
              if (v != value) v,
          ]
        : [...current, value];
    return _copy(
      fieldValues: {...fieldValues, field: next}
        ..removeWhere((_, v) => v.isEmpty),
    );
  }

  SearchRequest without(ActiveFilter filter) => switch (filter) {
    CategoryFilter() => withCategory(null),
    PriceFilter() => withPrice(null, null),
    FieldFilter(:final field) => _copy(
      fieldValues: {...fieldValues}..remove(field),
    ),
  };

  SearchRequest clearFilters() =>
      SearchRequest(q: q, sort: sort, radiusKm: radiusKm);

  /// The API's `filters`: `{"field": {"in": [...]}}`; `eq` for a bool field.
  Map<String, Map<String, Object>> get fieldFilters => {
    for (final entry in fieldValues.entries)
      if (entry.value.isNotEmpty)
        entry.key:
            entry.value.every((v) => v == 'true' || v == 'false') &&
                entry.value.length == 1
            ? {'eq': entry.value.single == 'true'}
            : {'in': entry.value},
  };

  /// GET /search's query parameters for the first page (or [cursor]'s).
  Map<String, Object> queryParameters({
    double? lat,
    double? lng,
    String? cursor,
  }) => {
    'type': 'posts',
    if (text.isNotEmpty) 'q': text,
    'scope': radiusKm == null ? 'area' : 'nearby',
    'radius_km': ?radiusKm,
    'category': ?categorySlug,
    if (categorySlug != null && fieldFilters.isNotEmpty)
      'filters': jsonEncode(fieldFilters),
    'price_min': ?priceMin,
    'price_max': ?priceMax,
    'sort': sort.api,
    if (lat != null && lng != null) ...{'lat': lat, 'lng': lng},
    'cursor': ?cursor,
  };

  /// What a saved search stores (the same meaning, ADR 041).
  SavedSearchFilters toSavedFilters() => SavedSearchFilters(
    category: categorySlug,
    fields: categorySlug == null ? const {} : fieldFilters,
    priceMin: priceMin,
    priceMax: priceMax,
  );

  String get _key => jsonEncode([
    text,
    categorySlug,
    fieldFilters,
    priceMin,
    priceMax,
    sort.api,
    radiusKm,
  ]);

  @override
  bool operator ==(Object other) =>
      other is SearchRequest && other._key == _key;

  @override
  int get hashCode => _key.hashCode;
}
