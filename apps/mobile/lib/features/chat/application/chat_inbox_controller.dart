import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_session_state.dart';
import '../data/chat_api.dart';
import '../data/chat_models.dart';
import '../data/chat_realtime.dart';

/// The conversation on screen right now (its messages don't count as unread).
class ActiveConversation extends Notifier<String?> {
  @override
  String? build() => null;

  // Both run deferred (a microtask after a thread's build or dispose), so the
  // app may be gone by then.
  void set(String? id) {
    if (ref.mounted) state = id;
  }

  /// Leaving a thread: clear it, unless another one is already on screen.
  void clearIf(String id) {
    if (ref.mounted && state == id) state = null;
  }
}

final activeConversationProvider =
    NotifierProvider<ActiveConversation, String?>(ActiveConversation.new);

class ChatInboxState {
  const ChatInboxState({
    required this.items,
    this.nextCursor,
    this.loadingMore = false,
  });

  final List<Conversation> items;
  final String? nextCursor;
  final bool loadingMore;

  bool get hasMore => nextCursor != null;
  int get unreadTotal => items.fold(0, (sum, c) => sum + c.unreadCount);

  ChatInboxState copyWith({
    List<Conversation>? items,
    String? nextCursor,
    bool? loadingMore,
  }) => ChatInboxState(
    items: items ?? this.items,
    nextCursor: nextCursor ?? this.nextCursor,
    loadingMore: loadingMore ?? this.loadingMore,
  );
}

/// The chat inbox (ADR 060): every conversation the user is in, any area,
/// newest activity first — kept live from the socket: a new message moves
/// its conversation to the top with the new text and one more unread (not
/// for the thread on screen); a conversation the list doesn't have yet is
/// fetched; a change elsewhere (blocked, locked) refetches that one; a
/// reconnect reloads the first page. [archived] lists the archive instead.
class ChatInboxController extends AsyncNotifier<ChatInboxState> {
  ChatInboxController(this.archived);

  final bool archived;

  ChatApi get _api => ref.read(chatApiProvider);

  @override
  Future<ChatInboxState> build() async {
    if (ref.watch(authControllerProvider) is! AuthSessionAuthenticated) {
      return const ChatInboxState(items: []);
    }
    final realtime = ref.watch(chatRealtimeProvider);
    unawaited(realtime.start());
    final subscriptions = [
      realtime.messages.listen(_onMessage),
      realtime.conversationUpdated.listen((id) => unawaited(_refetch(id))),
      realtime.connected
          .where((up) => up)
          .listen((_) => unawaited(_reloadFirstPage())),
    ];
    ref.onDispose(() {
      for (final s in subscriptions) {
        unawaited(s.cancel());
      }
    });
    final page = await _api.inbox(archived: archived);
    return ChatInboxState(items: page.items, nextCursor: page.nextCursor);
  }

  Future<void> loadMore() async {
    final current = state.value;
    if (current == null || !current.hasMore || current.loadingMore) return;
    state = AsyncData(current.copyWith(loadingMore: true));
    try {
      final page = await _api.inbox(
        cursor: current.nextCursor,
        archived: archived,
      );
      state = AsyncData(
        ChatInboxState(
          items: [...current.items, ...page.items],
          nextCursor: page.nextCursor,
        ),
      );
    } on Object {
      state = AsyncData(current.copyWith(loadingMore: false));
    }
  }

  /// Swiped away: out of the list at once, back if the server refuses.
  /// Returns the conversation, for an undo.
  Future<Conversation?> archive(String id) => _move(id, archive: true);

  Future<void> unarchive(Conversation conversation) async {
    await _api.setArchived(conversation.id, archived: false);
    ref.invalidate(chatInboxProvider(false));
    ref.invalidate(chatInboxProvider(true));
  }

  Future<Conversation?> _move(String id, {required bool archive}) async {
    final current = state.value;
    if (current == null) return null;
    final gone = current.items.where((c) => c.id == id).firstOrNull;
    if (gone == null) return null;
    state = AsyncData(
      current.copyWith(
        items: [
          for (final c in current.items)
            if (c.id != id) c,
        ],
      ),
    );
    try {
      await _api.setArchived(id, archived: archive);
      ref.invalidate(chatInboxProvider(!archived));
      return gone;
    } on Object {
      state = AsyncData(current);
      rethrow;
    }
  }

  /// The thread was opened and read: no unread left there.
  void markSeen(String id) {
    final current = state.value;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        items: [
          for (final c in current.items)
            c.id == id ? c.copyWith(unreadCount: 0) : c,
        ],
      ),
    );
  }

  void _onMessage(IncomingMessage incoming) {
    final current = state.value;
    if (current == null) return;
    final message = incoming.message;
    final index = current.items.indexWhere(
      (c) => c.id == message.conversationId,
    );
    if (index < 0) {
      // A new conversation (or one in the other list): the server says where it goes.
      unawaited(_refetch(message.conversationId));
      return;
    }
    final conversation = current.items[index];
    final mine = message.senderMemberId == conversation.myMemberId;
    final open = ref.read(activeConversationProvider) == conversation.id;
    final updated = conversation.copyWith(
      lastMessage: message,
      activityAt: message.createdAt,
      unreadCount: mine || open
          ? conversation.unreadCount
          : conversation.unreadCount + 1,
    );
    // A new message brings an archived conversation back to the inbox (server side too).
    if (archived && !mine) {
      state = AsyncData(
        current.copyWith(items: [...current.items]..removeAt(index)),
      );
      ref.invalidate(chatInboxProvider(false));
      return;
    }
    state = AsyncData(
      current.copyWith(items: [updated, ...current.items]..removeAt(index + 1)),
    );
  }

  Future<void> _refetch(String id) async {
    try {
      final fresh = await _api.conversation(id);
      final current = state.value;
      if (current == null) return;
      final others = current.items.where((c) => c.id != id).toList();
      if (fresh.isArchived != archived) {
        state = AsyncData(current.copyWith(items: others));
        return;
      }
      final items = [...others, fresh]
        ..sort((a, b) => b.activityAt.compareTo(a.activityAt));
      state = AsyncData(current.copyWith(items: items));
    } on Object {
      // Not ours any more (left the store's staff) or offline: leave the list as it is.
    }
  }

  Future<void> _reloadFirstPage() async {
    try {
      final page = await _api.inbox(archived: archived);
      state = AsyncData(
        ChatInboxState(items: page.items, nextCursor: page.nextCursor),
      );
    } on Object {
      // Keep what's shown.
    }
  }
}

/// The inbox (false) or the archive (true).
final chatInboxProvider =
    AsyncNotifierProvider.family<ChatInboxController, ChatInboxState, bool>(
      ChatInboxController.new,
    );

/// The chat icon's badge: unread messages in the inbox.
final chatUnreadProvider = Provider<int>(
  (ref) => ref.watch(chatInboxProvider(false)).value?.unreadTotal ?? 0,
);
