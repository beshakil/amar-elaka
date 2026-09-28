import 'dart:async';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../feed/application/feed_controller.dart';
import '../../post_detail/data/engagement_api.dart';
import '../data/recent_searches_store.dart';
import '../data/search_api.dart';
import '../domain/search_request.dart';

/// What the results screen shows.
class SearchState {
  const SearchState({
    this.request = const SearchRequest(),
    this.submitted = false,
    this.result,
    this.hits = const [],
    this.nextCursor,
    this.loading = false,
    this.loadingMore = false,
    this.error,
    this.moreError,
    this.savedIds = const {},
    this.radiusAtMax = false,
  });

  final SearchRequest request;

  /// A search has been run (the screen shows results, not suggestions).
  final bool submitted;

  /// The first page's answer: facets, total, radius, landmarks.
  final SearchResult? result;

  /// Every page so far.
  final List<SearchHit> hits;
  final String? nextCursor;
  final bool loading;
  final bool loadingMore;
  final AppException? error;
  final AppException? moreError;

  /// Posts the viewer saved from these results (the hearts).
  final Set<String> savedIds;

  /// Asked for a wider radius and the server kept the old one: at its
  /// maximum, so the empty state stops offering to widen.
  final bool radiusAtMax;

  bool get hasMore => nextCursor != null;
  bool get isEmpty => submitted && !loading && error == null && hits.isEmpty;

  SearchState copyWith({
    SearchRequest? request,
    bool? submitted,
    SearchResult? Function()? result,
    List<SearchHit>? hits,
    String? Function()? nextCursor,
    bool? loading,
    bool? loadingMore,
    AppException? Function()? error,
    AppException? Function()? moreError,
    Set<String>? savedIds,
    bool? radiusAtMax,
  }) => SearchState(
    request: request ?? this.request,
    submitted: submitted ?? this.submitted,
    result: result != null ? result() : this.result,
    hits: hits ?? this.hits,
    nextCursor: nextCursor != null ? nextCursor() : this.nextCursor,
    loading: loading ?? this.loading,
    loadingMore: loadingMore ?? this.loadingMore,
    error: error != null ? error() : this.error,
    moreError: moreError != null ? moreError() : this.moreError,
    savedIds: savedIds ?? this.savedIds,
    radiusAtMax: radiusAtMax ?? this.radiusAtMax,
  );
}

/// Search results (ADR 040): each change of the request (text, category,
/// filter value, price range, sort, radius) loads a new first page; next
/// pages by cursor. A late answer to an older request never overwrites a
/// newer one.
class SearchController extends Notifier<SearchState> {
  int _generation = 0;

  SearchApi get _api => ref.read(searchApiProvider);

  @override
  SearchState build() => const SearchState();

  /// Runs [q] with the current filters; remembers it as a recent search.
  Future<void> submit(String q) async {
    if (q.trim().isNotEmpty) {
      await ref.read(recentSearchesStoreProvider).add(q);
    }
    if (!ref.mounted) return;
    return _run(state.request.withText(q));
  }

  /// Opens a category from a suggestion: its results, no text needed.
  Future<void> openCategory(String slug) =>
      _run(const SearchRequest().withCategory(slug));

  Future<void> setCategory(String? slug) =>
      _run(state.request.withCategory(slug));

  Future<void> toggleFieldValue(String field, String value) =>
      _run(state.request.toggleFieldValue(field, value));

  Future<void> setPrice(String? min, String? max) =>
      _run(state.request.withPrice(min, max));

  Future<void> setSort(SearchSort sort) => _run(state.request.withSort(sort));

  Future<void> removeFilter(ActiveFilter filter) =>
      _run(state.request.without(filter));

  Future<void> clearFilters() => _run(state.request.clearFilters());

  /// Twice the radius the last answer used (the server caps it).
  Future<void> widenRadius() {
    final current = state.result?.radiusKm;
    if (current == null) return Future.value();
    return _run(state.request.withRadius(current * 2), widening: current);
  }

  Future<void> retry() => _run(state.request);

  Future<void> _run(SearchRequest request, {double? widening}) async {
    final generation = ++_generation;
    state = state.copyWith(
      request: request,
      submitted: true,
      loading: true,
      hits: const [],
      result: () => null,
      nextCursor: () => null,
      error: () => null,
      moreError: () => null,
      radiusAtMax: widening == null ? false : state.radiusAtMax,
    );
    try {
      final position = await ref.read(viewerPositionProvider.future);
      final result = await _api.search(
        request,
        lat: position?.latitude,
        lng: position?.longitude,
      );
      if (generation != _generation) return;
      state = state.copyWith(
        loading: false,
        result: () => result,
        hits: result.hits,
        nextCursor: () => result.nextCursor,
        radiusAtMax:
            widening != null &&
            result.radiusKm != null &&
            result.radiusKm! <= widening,
      );
    } on AppException catch (error) {
      if (generation != _generation) return;
      state = state.copyWith(loading: false, error: () => error);
    }
  }

  Future<void> loadMore() async {
    final cursor = state.nextCursor;
    if (cursor == null || state.loading || state.loadingMore) return;
    final generation = _generation;
    state = state.copyWith(loadingMore: true, moreError: () => null);
    try {
      final position = await ref.read(viewerPositionProvider.future);
      final page = await _api.search(
        state.request,
        lat: position?.latitude,
        lng: position?.longitude,
        cursor: cursor,
      );
      if (generation != _generation) return;
      state = state.copyWith(
        hits: [...state.hits, ...page.hits],
        nextCursor: () => page.nextCursor,
        loadingMore: false,
      );
    } on AppException catch (error) {
      if (generation != _generation) return;
      state = state.copyWith(loadingMore: false, moreError: () => error);
    }
  }

  /// The viewer opened a result: tell the query log (best effort).
  void opened(String postId) {
    final searchId = state.result?.searchId;
    if (searchId != null) unawaited(_api.click(searchId, postId));
  }

  /// Heart on a result card: at once, rolled back if the server refuses.
  Future<void> toggleSaved(String postId) async {
    final saved = state.savedIds.contains(postId);
    final engagement = ref.read(engagementApiProvider);
    state = state.copyWith(
      savedIds: saved
          ? ({...state.savedIds}..remove(postId))
          : {...state.savedIds, postId},
    );
    try {
      await (saved ? engagement.unsave(postId) : engagement.save(postId));
    } on AppException {
      state = state.copyWith(
        savedIds: saved
            ? {...state.savedIds, postId}
            : ({...state.savedIds}..remove(postId)),
      );
      rethrow;
    }
  }
}

final searchControllerProvider =
    NotifierProvider.autoDispose<SearchController, SearchState>(
      SearchController.new,
    );
