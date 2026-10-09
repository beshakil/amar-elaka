import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../data/store_api.dart';
import '../data/store_models.dart';

class StorePageState {
  const StorePageState({
    required this.page,
    this.category,
    this.loadingMore = false,
    this.switching = false,
  });

  final StorePageData page;

  /// The catalog tab; null = everything.
  final String? category;
  final bool loadingMore;

  /// A tab's products are on their way (the header stays).
  final bool switching;

  StorePageState copyWith({
    StorePageData? page,
    String? category,
    bool clearCategory = false,
    bool? loadingMore,
    bool? switching,
  }) => StorePageState(
    page: page ?? this.page,
    category: clearCategory ? null : category ?? this.category,
    loadingMore: loadingMore ?? this.loadingMore,
    switching: switching ?? this.switching,
  );
}

/// A store's public page (ADR 054/057): its header, the catalog by category
/// tab, paged on demand, and following it.
class StorePageController extends AsyncNotifier<StorePageState> {
  StorePageController(this.slug);

  final String slug;

  StoreApi get _api => ref.read(storeApiProvider);

  @override
  Future<StorePageState> build() async =>
      StorePageState(page: await ref.watch(storeApiProvider).page(slug));

  /// Shows one catalog tab (null = all); a failure keeps the current one.
  Future<void> selectCategory(String? category) async {
    final current = state.value;
    if (current == null || current.category == category) return;
    state = AsyncData(current.copyWith(switching: true));
    try {
      final page = await _api.page(slug, category: category);
      if (!ref.mounted) return;
      state = AsyncData(StorePageState(page: page, category: category));
    } on AppException {
      if (ref.mounted) state = AsyncData(current.copyWith(switching: false));
    }
  }

  Future<void> loadMore() async {
    final current = state.value;
    final cursor = current?.page.nextCursor;
    if (current == null || cursor == null || current.loadingMore) return;
    state = AsyncData(current.copyWith(loadingMore: true));
    try {
      final next = await _api.page(
        slug,
        category: current.category,
        cursor: cursor,
      );
      if (!ref.mounted) return;
      state = AsyncData(
        current.copyWith(
          loadingMore: false,
          page: current.page.copyWith(
            posts: [...current.page.posts, ...next.posts],
            nextCursor: next.nextCursor,
            clearCursor: next.nextCursor == null,
          ),
        ),
      );
    } on AppException {
      if (ref.mounted) state = AsyncData(current.copyWith(loadingMore: false));
    }
  }

  /// Follow or unfollow at once; back if the server says no (rethrown).
  Future<void> toggleFollow() async {
    final current = state.value;
    if (current == null) return;
    final follow = !current.page.isFollowing;
    state = AsyncData(
      current.copyWith(
        page: current.page.copyWith(
          isFollowing: follow,
          followerCount: current.page.followerCount + (follow ? 1 : -1),
        ),
      ),
    );
    try {
      final result = await _api.setFollowing(current.page.id, follow: follow);
      if (!ref.mounted) return;
      final now = state.value ?? current;
      state = AsyncData(
        now.copyWith(
          page: now.page.copyWith(
            isFollowing: result.following,
            followerCount: result.followerCount,
          ),
        ),
      );
    } on AppException {
      if (ref.mounted) state = AsyncData(current);
      rethrow;
    }
  }
}

final storePageProvider = AsyncNotifierProvider.autoDispose
    .family<StorePageController, StorePageState, String>(
      StorePageController.new,
    );
