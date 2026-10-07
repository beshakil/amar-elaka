import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../data/notifications_api.dart';

/// The bell's badge: unread notifications (0 for a guest or on failure, so a
/// badge never blocks anything). Invalidate it to look again.
final unreadNotificationsProvider = FutureProvider<int>((ref) async {
  if (ref.watch(authControllerProvider) is! AuthSessionAuthenticated) return 0;
  try {
    return await ref.watch(notificationsApiProvider).unreadCount();
  } on Object {
    return 0;
  }
});

class InboxState {
  const InboxState({
    this.items = const [],
    this.nextCursor,
    this.loadingMore = false,
  });

  final List<InboxItem> items;
  final String? nextCursor;
  final bool loadingMore;

  bool get hasMore => nextCursor != null;
}

/// The inbox list: first page on open, more on demand, read state kept in
/// step with the server (optimistically).
class InboxController extends AsyncNotifier<InboxState> {
  NotificationsApi get _api => ref.read(notificationsApiProvider);

  @override
  Future<InboxState> build() async {
    final page = await ref.watch(notificationsApiProvider).page();
    return InboxState(items: page.items, nextCursor: page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(
      InboxState(
        items: current.items,
        nextCursor: current.nextCursor,
        loadingMore: true,
      ),
    );
    try {
      final page = await _api.page(cursor: current.nextCursor);
      state = AsyncData(
        InboxState(
          items: [...current.items, ...page.items],
          nextCursor: page.nextCursor,
        ),
      );
    } on Object {
      state = AsyncData(current);
    }
  }

  /// Opening one marks it read; a failure only leaves it unread.
  Future<void> markRead(InboxItem item) async {
    if (item.read) return;
    _replace(item.id, item.asRead());
    try {
      await _api.markRead(item.id);
    } on Object {
      _replace(item.id, item);
    }
    ref.invalidate(unreadNotificationsProvider);
  }

  Future<void> markAllRead() async {
    final current = state.value;
    if (current == null) return;
    await _api.markAllRead();
    state = AsyncData(
      InboxState(
        items: [for (final i in current.items) i.asRead()],
        nextCursor: current.nextCursor,
      ),
    );
    ref.invalidate(unreadNotificationsProvider);
  }

  void _replace(String id, InboxItem next) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      InboxState(
        items: [for (final i in current.items) i.id == id ? next : i],
        nextCursor: current.nextCursor,
        loadingMore: current.loadingMore,
      ),
    );
  }
}

final inboxControllerProvider =
    AsyncNotifierProvider.autoDispose<InboxController, InboxState>(
      InboxController.new,
    );
