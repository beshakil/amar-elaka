import 'dart:convert';

import '../../../core/dynamic_form/filters.dart';

/// Where the feed looks (apps/api/src/feed/dto/feed.dto.ts): the viewer's
/// area, a wider radius around them, or the whole country (shippable
/// categories only).
enum FeedScope {
  area('area'),
  nearby('nearby'),
  country('country');

  const FeedScope(this.api);

  final String api;
}

/// What the feed shows: scope, category and the filter panel's state. The
/// first page of each distinct query is what the offline cache keeps.
class FeedQuery {
  const FeedQuery({
    this.scope = FeedScope.area,
    this.categorySlug,
    this.filterState = const {},
    this.filters = const [],
  });

  final FeedScope scope;
  final String? categorySlug;

  /// The filter sheet's raw state (to reopen it as it was).
  final Map<String, Object?> filterState;

  /// What the API receives.
  final List<RawFieldFilter> filters;

  FeedQuery withScope(FeedScope scope) => FeedQuery(
    scope: scope,
    categorySlug: categorySlug,
    filterState: filterState,
    filters: filters,
  );

  /// A new category drops the old category's filters.
  FeedQuery withCategory(String? slug) =>
      FeedQuery(scope: scope, categorySlug: slug);

  FeedQuery withFilters(
    Map<String, Object?> state,
    List<RawFieldFilter> filters,
  ) => FeedQuery(
    scope: scope,
    categorySlug: categorySlug,
    filterState: state,
    filters: filters,
  );

  /// The API's `filters` parameter: `{"field": {"op": "value"}}`.
  String? get filtersJson {
    if (filters.isEmpty || categorySlug == null) return null;
    final grouped = <String, Map<String, String>>{};
    for (final f in filters) {
      (grouped[f.field] ??= {})[f.op] = f.value;
    }
    return jsonEncode(grouped);
  }

  /// Stable key of this query's first page in the offline cache.
  String get cacheKey =>
      ['feed', scope.api, categorySlug ?? '*', filtersJson ?? ''].join('|');

  @override
  bool operator ==(Object other) =>
      other is FeedQuery && other.cacheKey == cacheKey;

  @override
  int get hashCode => cacheKey.hashCode;
}
