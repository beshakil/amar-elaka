import '../feed/feed.dart';
import '../tenants/lat_lng.dart';

/// `GET /search`, `/search/suggest`, `/search/trending` (ADR 040) and
/// `/saved-searches` (ADR 041): apps/api/src/search/dto/search.dto.ts and
/// apps/api/src/saved-searches/dto/saved-searches.dto.ts. Hand-written like
/// the feed models; unions (facets) parse by their `kind`.

double? _double(Object? value) => (value as num?)?.toDouble();

List<Map<String, dynamic>> _maps(Object? value) => [
  for (final item in value as List<dynamic>? ?? const [])
    item as Map<String, dynamic>,
];

/// A search result as the API sends it. [toCard] turns a post hit into the
/// feed's card, so search results look exactly like the feed.
class SearchHit {
  const SearchHit({
    required this.id,
    required this.type,
    required this.tenantId,
    required this.name,
    required this.categorySlug,
    required this.area,
    required this.distanceMeters,
    required this.isBoosted,
    required this.publishedAt,
    required this.price,
    required this.coverUrl,
    required this.coverThumbhash,
    required this.isLandmark,
  });

  factory SearchHit.fromJson(Map<String, dynamic> json) {
    final cover = json['cover'] as Map<String, dynamic>?;
    final category = json['category'] as Map<String, dynamic>?;
    final area = json['area'] as Map<String, dynamic>?;
    return SearchHit(
      id: json['id'] as String,
      type: json['type'] as String,
      tenantId: json['tenantId'] as String,
      name: OptionalName.fromJson(json['name'] as Map<String, dynamic>),
      categorySlug: category?['slug'] as String?,
      area: area == null ? null : OptionalName.fromJson(area),
      distanceMeters: _double(json['distanceMeters']),
      isBoosted: json['isBoosted'] as bool? ?? false,
      publishedAt: DateTime.parse(json['publishedAt'] as String),
      price: json['price'] as String?,
      coverUrl: cover?['thumbUrl'] as String?,
      coverThumbhash: cover?['thumbhash'] as String?,
      isLandmark: json['isLandmark'] as bool? ?? false,
    );
  }

  final String id;

  /// posts | stores | places
  final String type;
  final String tenantId;

  /// The title as written: Bengali script in `bn`, Latin in `en`.
  final OptionalName name;
  final String? categorySlug;
  final OptionalName? area;

  /// Metres from the viewer; null when they shared no location.
  final double? distanceMeters;
  final bool isBoosted;
  final DateTime publishedAt;

  /// Money as a string with two decimals, never a number.
  final String? price;
  final String? coverUrl;
  final String? coverThumbhash;
  final bool isLandmark;

  String get title => name.bn ?? name.en ?? '';

  /// The feed's post card for this hit; [isSaved] from the app's own state.
  FeedPostCard toCard({bool isSaved = false}) => FeedPostCard(
    id: id,
    tenantId: tenantId,
    title: title,
    price: price,
    cover: coverUrl == null
        ? null
        : CoverImage(url: coverUrl!, thumbhash: coverThumbhash),
    distanceMeters: distanceMeters,
    area: area,
    badges: [if (isBoosted) 'boosted'],
    createdAt: publishedAt,
    isSaved: isSaved,
  );
}

class CategoryCount {
  const CategoryCount({required this.slug, required this.count});

  final String slug;
  final int count;
}

class PriceBucket {
  const PriceBucket({
    required this.min,
    required this.max,
    required this.count,
  });

  /// Money strings: pass back as price_min (inclusive) / price_max (exclusive).
  final String min;

  /// Null on the last, open-ended range.
  final String? max;
  final int count;
}

class PriceFacet {
  const PriceFacet({
    required this.min,
    required this.max,
    required this.buckets,
  });

  factory PriceFacet.fromJson(Map<String, dynamic> json) => PriceFacet(
    min: json['min'] as String,
    max: json['max'] as String,
    buckets: [
      for (final b in _maps(json['buckets']))
        PriceBucket(
          min: b['min'] as String,
          max: b['max'] as String?,
          count: b['count'] as int,
        ),
    ],
  );

  final String min;
  final String max;
  final List<PriceBucket> buckets;
}

/// A custom field's facet: value counts (select-type fields) or a range.
sealed class FieldFacet {
  const FieldFacet();

  static FieldFacet? fromJson(Map<String, dynamic> json) =>
      switch (json['kind']) {
        'values' => ValuesFacet([
          for (final v in _maps(json['values']))
            (value: v['value'] as String, count: v['count'] as int),
        ]),
        'range' => RangeFacet(min: '${json['min']}', max: '${json['max']}'),
        _ => null,
      };
}

final class ValuesFacet extends FieldFacet {
  const ValuesFacet(this.values);

  final List<({String value, int count})> values;
}

final class RangeFacet extends FieldFacet {
  const RangeFacet({required this.min, required this.max});

  final String min;
  final String max;
}

class SearchFacets {
  const SearchFacets({
    required this.categories,
    required this.price,
    required this.fields,
  });

  factory SearchFacets.fromJson(Map<String, dynamic> json) {
    final price = json['price'] as Map<String, dynamic>?;
    final fields = json['fields'] as Map<String, dynamic>? ?? const {};
    return SearchFacets(
      categories: [
        for (final c in _maps(json['categories']))
          CategoryCount(slug: c['slug'] as String, count: c['count'] as int),
      ],
      price: price == null ? null : PriceFacet.fromJson(price),
      fields: {
        for (final entry in fields.entries)
          entry.key: ?FieldFacet.fromJson(entry.value as Map<String, dynamic>),
      },
    );
  }

  static const empty = SearchFacets(categories: [], price: null, fields: {});

  final List<CategoryCount> categories;
  final PriceFacet? price;
  final Map<String, FieldFacet> fields;
}

/// One page of `GET /search`.
class SearchResult {
  const SearchResult({
    required this.query,
    required this.searchId,
    required this.hits,
    required this.landmarks,
    required this.nextCursor,
    required this.totalHits,
    required this.scope,
    required this.radiusKm,
    required this.facets,
    required this.degraded,
  });

  factory SearchResult.fromJson(Map<String, dynamic> json) => SearchResult(
    query: json['query'] as String,
    searchId: json['searchId'] as String?,
    hits: [for (final h in _maps(json['hits'])) SearchHit.fromJson(h)],
    landmarks: [
      for (final h in _maps(json['landmarks'])) SearchHit.fromJson(h),
    ],
    nextCursor: json['nextCursor'] as String?,
    totalHits: json['totalHits'] as int,
    scope: json['scope'] as String,
    radiusKm: _double(json['radiusKm']),
    facets: SearchFacets.fromJson(json['facets'] as Map<String, dynamic>),
    degraded: json['degraded'] as bool? ?? false,
  );

  final String query;

  /// For POST /search/click; null when the search wasn't logged.
  final String? searchId;
  final List<SearchHit> hits;
  final List<SearchHit> landmarks;
  final String? nextCursor;

  /// Meilisearch's estimate: "about N results".
  final int totalHits;
  final String scope;

  /// The radius used; null in the country scope.
  final double? radiusKm;
  final SearchFacets facets;

  /// Search answered from the database: this area only, no facets.
  final bool degraded;
}

class SuggestedCategory {
  const SuggestedCategory({required this.slug, required this.name});

  final String slug;
  final OptionalName name;
}

class SuggestedListing {
  const SuggestedListing({
    required this.id,
    required this.title,
    required this.categorySlug,
  });

  final String id;
  final OptionalName title;
  final String? categorySlug;
}

/// `GET /search/suggest`: categories, popular queries and listing titles.
class SuggestResult {
  const SuggestResult({
    required this.query,
    required this.categories,
    required this.queries,
    required this.listings,
  });

  factory SuggestResult.fromJson(Map<String, dynamic> json) => SuggestResult(
    query: json['query'] as String,
    categories: [
      for (final c in _maps(json['categories']))
        SuggestedCategory(
          slug: c['slug'] as String,
          name: OptionalName.fromJson(c['name'] as Map<String, dynamic>),
        ),
    ],
    queries: [for (final q in _maps(json['queries'])) q['query'] as String],
    listings: [
      for (final l in _maps(json['listings']))
        SuggestedListing(
          id: l['id'] as String,
          title: OptionalName.fromJson(l['title'] as Map<String, dynamic>),
          categorySlug: l['categorySlug'] as String?,
        ),
    ],
  );

  static const empty = SuggestResult(
    query: '',
    categories: [],
    queries: [],
    listings: [],
  );

  final String query;
  final List<SuggestedCategory> categories;
  final List<String> queries;
  final List<SuggestedListing> listings;

  bool get isEmpty => categories.isEmpty && queries.isEmpty && listings.isEmpty;
}

/// `GET /search/trending`.
class TrendingResult {
  const TrendingResult({required this.windowHours, required this.queries});

  factory TrendingResult.fromJson(Map<String, dynamic> json) => TrendingResult(
    windowHours: json['windowHours'] as int,
    queries: [for (final q in _maps(json['queries'])) q['query'] as String],
  );

  final int windowHours;
  final List<String> queries;
}

/// instant | daily | off (ADR 041).
enum AlertFrequency {
  instant('instant'),
  daily('daily'),
  off('off');

  const AlertFrequency(this.api);

  final String api;

  static AlertFrequency parse(String value) =>
      values.firstWhere((f) => f.api == value, orElse: () => daily);
}

/// What narrows a saved search: the search API's category, field filters
/// (`{field: {op: value}}`) and price range.
class SavedSearchFilters {
  const SavedSearchFilters({
    this.category,
    this.fields = const {},
    this.priceMin,
    this.priceMax,
  });

  factory SavedSearchFilters.fromJson(Map<String, dynamic> json) =>
      SavedSearchFilters(
        category: json['category'] as String?,
        fields: {
          for (final entry
              in (json['fields'] as Map<String, dynamic>? ?? const {}).entries)
            entry.key: Map<String, Object>.from(entry.value as Map),
        },
        priceMin: json['priceMin'] as String?,
        priceMax: json['priceMax'] as String?,
      );

  final String? category;
  final Map<String, Map<String, Object>> fields;
  final String? priceMin;
  final String? priceMax;

  /// The request body's shape (snake_case prices).
  Map<String, dynamic> toRequestJson() => {
    'category': ?category,
    if (fields.isNotEmpty) 'fields': fields,
    'price_min': ?priceMin,
    'price_max': ?priceMax,
  };
}

class SavedSearch {
  const SavedSearch({
    required this.id,
    required this.name,
    required this.q,
    required this.filters,
    required this.center,
    required this.radiusKm,
    required this.frequency,
    required this.active,
    required this.pausedAt,
    required this.newResultCount,
    required this.createdAt,
  });

  factory SavedSearch.fromJson(Map<String, dynamic> json) => SavedSearch(
    id: json['id'] as String,
    name: json['name'] as String,
    q: json['q'] as String,
    filters: SavedSearchFilters.fromJson(
      json['filters'] as Map<String, dynamic>,
    ),
    center: LatLng.fromJson(json['center'] as Map<String, dynamic>),
    radiusKm: (json['radiusKm'] as num).toDouble(),
    frequency: AlertFrequency.parse(json['frequency'] as String),
    active: json['active'] as bool,
    pausedAt: json['pausedAt'] == null
        ? null
        : DateTime.parse(json['pausedAt'] as String),
    newResultCount: json['newResultCount'] as int,
    createdAt: DateTime.parse(json['createdAt'] as String),
  );

  final String id;
  final String name;
  final String q;
  final SavedSearchFilters filters;
  final LatLng center;
  final double radiusKm;
  final AlertFrequency frequency;

  /// Matching and notifying: switched on and not auto-paused.
  final bool active;

  /// Set when it was paused for not being opened.
  final DateTime? pausedAt;

  /// The badge: results not opened yet.
  final int newResultCount;
  final DateTime createdAt;
}

class SavedSearchList {
  const SavedSearchList({
    required this.items,
    required this.newResultCount,
    required this.maxActive,
    required this.activeCount,
  });

  factory SavedSearchList.fromJson(Map<String, dynamic> json) =>
      SavedSearchList(
        items: [for (final s in _maps(json['items'])) SavedSearch.fromJson(s)],
        newResultCount: json['newResultCount'] as int,
        maxActive: json['maxActive'] as int,
        activeCount: json['activeCount'] as int,
      );

  final List<SavedSearch> items;
  final int newResultCount;
  final int maxActive;
  final int activeCount;
}

/// `GET /saved-searches/:id/new-results`.
class SavedSearchNewResults {
  const SavedSearchNewResults({required this.search, required this.results});

  factory SavedSearchNewResults.fromJson(Map<String, dynamic> json) =>
      SavedSearchNewResults(
        search: SavedSearch.fromJson(json['search'] as Map<String, dynamic>),
        results: [
          for (final r in _maps(json['results'])) FeedPostCard.fromJson(r),
        ],
      );

  final SavedSearch search;
  final List<FeedPostCard> results;
}
