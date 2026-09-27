import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../data/posts_api.dart';

/// The "my posts" tabs. Status tabs show only posts that aren't hidden;
/// hidden posts, whatever their status, have their own tab.
enum MyPostsTab {
  live(['live']),
  pending(['pending']),
  sold(['sold']),
  expired(['expired']),
  rejected(['rejected', 'removed']),
  hidden(null);

  const MyPostsTab(this.statuses);

  final List<String>? statuses;

  int countIn(MyPostCounts counts) => switch (this) {
    live => counts.live,
    pending => counts.pending,
    sold => counts.sold,
    expired => counts.expired,
    rejected => counts.rejected + counts.removed,
    hidden => counts.hidden,
  };
}

/// One tab's list, paged by cursor (GET /posts/me).
class MyPostsList extends ChangeNotifier {
  MyPostsList(this._api, this.tab) {
    refresh();
  }

  final PostsApi _api;
  final MyPostsTab tab;

  List<PostView> _items = const [];
  String? _cursor;
  bool _loading = false;
  bool _done = false;
  AppException? _error;
  bool _disposed = false;

  List<PostView> get items => _items;
  bool get loading => _loading;
  bool get hasMore => !_done;
  AppException? get error => _error;

  Future<void> refresh() async {
    _items = const [];
    _cursor = null;
    _done = false;
    await loadMore();
  }

  Future<void> loadMore() async {
    if (_loading || _done) return;
    _loading = true;
    _error = null;
    _notify();
    try {
      final page = await _api.mine(
        statuses: tab.statuses,
        hidden: tab == MyPostsTab.hidden,
        cursor: _cursor,
      );
      _items = [..._items, ...page.items];
      _cursor = page.nextCursor;
      _done = page.nextCursor == null;
    } on AppException catch (error) {
      _error = error;
    } finally {
      _loading = false;
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

final myPostsListProvider = Provider.autoDispose
    .family<MyPostsList, MyPostsTab>((ref, tab) {
      final list = MyPostsList(ref.watch(postsApiProvider), tab);
      ref.onDispose(list.dispose);
      return list;
    });

final myPostCountsProvider = FutureProvider.autoDispose<MyPostCounts>(
  (ref) => ref.watch(postsApiProvider).counts(),
);
