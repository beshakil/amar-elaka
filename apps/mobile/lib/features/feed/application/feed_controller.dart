import 'dart:async';
import 'dart:convert';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/dynamic_form/filters.dart';
import '../../../core/network/api_exception.dart';
import '../../post/application/current_tenant.dart';
import '../../post_detail/data/engagement_api.dart';
import '../../tenant_bootstrap/data/location_service.dart';
import '../data/feed_api.dart';
import '../data/feed_cache_store.dart';
import '../domain/feed_query.dart';

/// What the feed screen shows.
class FeedState {
  const FeedState({
    required this.query,
    this.items = const [],
    this.nextCursor,
    this.loading = false,
    this.loadingMore = false,
    this.cachedAt,
    this.error,
    this.moreError,
  });

  final FeedQuery query;
  final List<FeedItem> items;
  final String? nextCursor;

  /// The first page is on its way and there's nothing (not even a cache) to show.
  final bool loading;
  final bool loadingMore;

  /// Non-null while the items are the offline copy from this moment.
  final DateTime? cachedAt;

  /// The first page failed and nothing is cached: the screen offers a retry.
  final AppException? error;

  /// The next page failed: a retry row at the end of the list.
  final AppException? moreError;

  bool get hasMore => nextCursor != null;
  bool get isOffline => cachedAt != null;

  FeedState copyWith({
    FeedQuery? query,
    List<FeedItem>? items,
    String? Function()? nextCursor,
    bool? loading,
    bool? loadingMore,
    DateTime? Function()? cachedAt,
    AppException? Function()? error,
    AppException? Function()? moreError,
  }) => FeedState(
    query: query ?? this.query,
    items: items ?? this.items,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    cachedAt: cachedAt != null ? cachedAt() : this.cachedAt,
    error: error != null ? error() : this.error,
    moreError: moreError != null ? moreError() : this.moreError,
  );
}

/// The viewer's position for distances and the radius, if location is
/// already allowed; null = the area's centre stands in (server side).
final viewerPositionProvider = FutureProvider<LocationGranted?>(
  (ref) => ref.watch(locationServiceProvider).positionIfAllowed(),
);

/// The home feed (ADR 038): first page from the offline cache at once (if
/// any), then from the network; next pages by cursor; saved hearts updated
/// immediately and rolled back if the server refuses.
class FeedController extends Notifier<FeedState> {
  /// Bumped by every new first-page load: an older load that finishes late
  /// never overwrites a newer query's items.
  int _generation = 0;

  /// When the items on screen came from the network.
  DateTime? _loadedAt;

  FeedApi get _api => ref.read(feedApiProvider);
  FeedCacheStore get _cache => ref.read(feedCacheStoreProvider);
  String get _tenantId => ref.read(currentTenantConfigProvider)?.id ?? 'none';

  @override
  FeedState build() {
    const query = FeedQuery();
    Future.microtask(() => _loadFirst(query));
    return const FeedState(query: query, loading: true);
  }

  /// Pull to refresh; completes when the fresh first page (or its failure) lands.
  Future<void> refresh() => _loadFirst(state.query, keepItems: true);

  Future<void> setScope(FeedScope scope) =>
      _changeQuery(state.query.withScope(scope));

  Future<void> setCategory(String? slug) =>
      _changeQuery(state.query.withCategory(slug));

  Future<void> setFilters(
    Map<String, Object?> filterState,
    List<RawFieldFilter> filters,
  ) => _changeQuery(state.query.withFilters(filterState, filters));

  Future<void> _changeQuery(FeedQuery query) {
    if (query == state.query) return Future.value();
    return _loadFirst(query);
  }

  Future<void> _loadFirst(FeedQuery query, {bool keepItems = false}) async {
    final generation = ++_generation;
    final cached = await _readCache(query);
    if (generation != _generation) return;
    if (!keepItems) {
      state = FeedState(
        query: query,
        items: cached?.page.items ?? const [],
        nextCursor: cached?.page.nextCursor,
        loading: cached == null,
        // Shown as offline only if the network then fails.
      );
    }

    try {
      final position = await ref.read(viewerPositionProvider.future);
      final fetch = await _api.page(
        query,
        lat: position?.latitude,
        lng: position?.longitude,
      );
      if (generation != _generation) return;
      state = FeedState(
        query: query,
        items: fetch.page.items,
        nextCursor: fetch.page.nextCursor,
      );
      _loadedAt = DateTime.now();
      unawaited(_cache.write(_tenantId, query.cacheKey, fetch.rawJson));
    } on AppException catch (error) {
      if (generation != _generation) return;
      if (keepItems && state.items.isNotEmpty) {
        // A failed refresh keeps what's on screen, marked offline as of
        // when it was loaded.
        state = state.copyWith(
          cachedAt: () => state.cachedAt ?? _loadedAt ?? cached?.cachedAt,
        );
      } else if (cached != null) {
        state = FeedState(
          query: query,
          items: cached.page.items,
          nextCursor: cached.page.nextCursor,
          cachedAt: cached.cachedAt,
        );
      } else {
        state = FeedState(query: query, error: error);
      }
    }
  }

  Future<({FeedPage page, DateTime cachedAt})?> _readCache(
    FeedQuery query,
  ) async {
    try {
      final row = await _cache.read(_tenantId, query.cacheKey);
      if (row == null) return null;
      final page = FeedPage.fromJson(
        jsonDecode(row.rawJson) as Map<String, dynamic>,
      );
      return (page: page, cachedAt: row.cachedAt);
    } on Object {
      return null; // An unreadable cache is just no cache.
    }
  }

  /// The next page, if there is one and none is on its way.
  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loadingMore || state.loading) return;
    final generation = _generation;
    state = state.copyWith(loadingMore: true, moreError: () => null);
    try {
      final position = await ref.read(viewerPositionProvider.future);
      final fetch = await _api.page(
        state.query,
        lat: position?.latitude,
        lng: position?.longitude,
        cursor: cursor,
      );
      if (generation != _generation) return;
      state = state.copyWith(
        items: [...state.items, ...fetch.page.items],
        nextCursor: () => fetch.page.nextCursor,
        loadingMore: false,
        // A page from the network: the list is live again.
        cachedAt: () => null,
      );
    } on AppException catch (error) {
      if (generation != _generation) return;
      state = state.copyWith(loadingMore: false, moreError: () => error);
    }
  }

  /// Saves or unsaves a post card: the heart flips at once, and flips back
  /// (with the error rethrown for a message) if the server refuses.
  Future<void> toggleSaved(String postId) async {
    final card = _card(postId);
    if (card == null) return;
    final saving = !card.isSaved;
    markSaved(postId, saved: saving);
    try {
      final api = ref.read(engagementApiProvider);
      await (saving ? api.save(postId) : api.unsave(postId));
    } on AppException {
      markSaved(postId, saved: !saving);
      rethrow;
    }
  }

  /// Keeps the list in step with a save made elsewhere (the detail screen).
  void markSaved(String postId, {required bool saved}) {
    state = state.copyWith(
      items: [
        for (final item in state.items)
          if (item is FeedPostCard && item.id == postId)
            item.copyWith(isSaved: saved)
          else
            item,
      ],
    );
  }

  FeedPostCard? _card(String postId) {
    for (final item in state.items) {
      if (item is FeedPostCard && item.id == postId) return item;
    }
    return null;
  }
}

final feedControllerProvider = NotifierProvider<FeedController, FeedState>(
  FeedController.new,
);
