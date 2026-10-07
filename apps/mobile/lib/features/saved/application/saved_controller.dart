import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/saved_api.dart';

class SavedState {
  const SavedState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
  });

  final List<SavedItem> items;
  final String? nextCursor;
  final bool loadingMore;

  bool get hasMore => nextCursor != null;
}

/// The saved list for one filter (null = everything), paged on demand.
class SavedController extends AsyncNotifier<SavedState> {
  SavedController(this.type);

  final String? type;

  SavedApi get _api => ref.read(savedApiProvider);

  @override
  Future<SavedState> build() async {
    final page = await ref.watch(savedApiProvider).list(type: type);
    return SavedState(items: page.items, nextCursor: page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(
      SavedState(
        items: current.items,
        nextCursor: current.nextCursor,
        loadingMore: true,
      ),
    );
    try {
      final page = await _api.list(type: type, cursor: current.nextCursor);
      if (!ref.mounted) return;
      state = AsyncData(
        SavedState(
          items: [...current.items, ...page.items],
          nextCursor: page.nextCursor,
        ),
      );
    } on Object {
      if (ref.mounted) state = AsyncData(current);
    }
  }

  /// Gone from the list at once; back if the server says no.
  Future<bool> unsave(SavedItem item) async {
    final current = state.value;
    if (current == null) return false;
    state = AsyncData(
      SavedState(
        items: [
          for (final i in current.items)
            if (i.itemId != item.itemId) i,
        ],
        nextCursor: current.nextCursor,
      ),
    );
    try {
      await _api.unsave(item.itemType, item.itemId);
      return true;
    } on Object {
      if (ref.mounted) state = AsyncData(current);
      return false;
    }
  }
}

final savedControllerProvider = AsyncNotifierProvider.autoDispose
    .family<SavedController, SavedState, String?>(SavedController.new);
