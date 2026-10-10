import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/chat_api.dart';
import '../data/chat_models.dart';
import '../data/chat_realtime.dart';
import 'chat_inbox_controller.dart';
import 'chat_outbox.dart';

class ConversationState {
  const ConversationState({
    required this.conversation,
    required this.messages,
    required this.pending,
    required this.hasOlder,
    this.typing = false,
    this.quickReplies = const [],
  });

  final Conversation conversation;

  /// Oldest first (the list is drawn bottom-up).
  final List<ChatMessage> messages;

  /// Mine, not on the server yet (the outbox), oldest first.
  final List<PendingMessage> pending;
  final bool hasOlder;

  /// The other side is typing (ephemeral).
  final bool typing;

  /// The store's canned replies, for its owner and managers only.
  final List<QuickReply> quickReplies;

  bool isMine(ChatMessage m) => m.senderMemberId == conversation.myMemberId;

  ConversationState copyWith({
    Conversation? conversation,
    List<ChatMessage>? messages,
    List<PendingMessage>? pending,
    bool? hasOlder,
    bool? typing,
    List<QuickReply>? quickReplies,
  }) => ConversationState(
    conversation: conversation ?? this.conversation,
    messages: messages ?? this.messages,
    pending: pending ?? this.pending,
    hasOlder: hasOlder ?? this.hasOlder,
    typing: typing ?? this.typing,
    quickReplies: quickReplies ?? this.quickReplies,
  );
}

/// One open thread (ADR 060): history, then live — new messages, the other
/// side's receipts (ticks), typing — and what I'm sending (the outbox).
/// While it is open, it is joined on the socket (typing, no pushes for it)
/// and read up to the newest message; every reconnect fetches what was
/// missed. Sending goes through [ChatOutbox], so it works offline.
class ConversationController extends AsyncNotifier<ConversationState> {
  ConversationController(this.conversationId);

  final String conversationId;

  ChatApi get _api => ref.read(chatApiProvider);
  ChatRealtime get _realtime => ref.read(chatRealtimeProvider);
  ChatOutbox get _outbox => ref.read(chatOutboxProvider);

  /// Our typing signal: sent at most this often while typing, cleared after idle.
  static const _typingResend = Duration(seconds: 3);
  static const _typingIdle = Duration(seconds: 4);

  Timer? _typingExpiry;
  Timer? _heartbeat;
  Timer? _typingIdleTimer;
  DateTime? _lastTypingSent;

  @override
  Future<ConversationState> build() async {
    final realtime = ref.watch(chatRealtimeProvider);
    final outbox = ref.watch(chatOutboxProvider);
    unawaited(realtime.start());
    final results = await Future.wait([
      _api.conversation(conversationId),
      _api.history(conversationId),
    ]);
    final conversation = results[0] as Conversation;
    final history = results[1] as HistoryResult;
    final quickReplies = conversation.isSellerSide && conversation.store != null
        ? await _api.quickReplies(conversationId).catchError((Object _) => <QuickReply>[])
        : <QuickReply>[];

    final subscriptions = <StreamSubscription<Object?>>[
      realtime.messages.where((m) => m.message.conversationId == conversationId).listen(
        (m) => _accept(m.message, fromOthers: true),
      ),
      realtime.receipts.where((r) => r.conversationId == conversationId).listen(_onReceipt),
      realtime.typing.where((t) => t.conversationId == conversationId).listen(_onTyping),
      realtime.conversationUpdated.where((id) => id == conversationId).listen((_) => unawaited(_refresh())),
      realtime.connected.where((up) => up).listen((_) => unawaited(_onReconnect())),
      outbox.watch(conversationId).listen(_onPending),
      outbox.sent.where((r) => r.message.conversationId == conversationId).listen(
        (r) => _accept(r.message, fromOthers: false),
      ),
    ];
    // Not during build: a provider may not change another while it builds.
    final active = ref.read(activeConversationProvider.notifier);
    scheduleMicrotask(() => active.set(conversationId));
    ref.onDispose(() {
      for (final s in subscriptions) {
        unawaited(s.cancel());
      }
      _typingExpiry?.cancel();
      _heartbeat?.cancel();
      _typingIdleTimer?.cancel();
      realtime.leave(conversationId);
      scheduleMicrotask(() => active.clearIf(conversationId));
    });
    unawaited(_join());
    unawaited(outbox.flush());

    final messages = history.items.reversed.toList();
    _markRead(messages, conversation);
    return ConversationState(
      conversation: conversation,
      messages: messages,
      pending: const [],
      hasOlder: history.hasMore,
      quickReplies: quickReplies,
    );
  }

  // ---- sending -----------------------------------------------------------

  Future<void> sendText(String text) async {
    final body = text.trim();
    if (body.isEmpty) return;
    _stopTyping();
    await _outbox.enqueue(conversationId, TextDraft(body));
  }

  Future<void> sendImage(String localPath) =>
      _outbox.enqueue(conversationId, const ImageDraft(null), localImagePath: localPath);

  Future<void> sendLocation(double lat, double lng) =>
      _outbox.enqueue(conversationId, LocationDraft(lat, lng));

  Future<void> sharePost(String postId) => _outbox.enqueue(conversationId, ListingDraft(postId));

  Future<void> retry(PendingMessage message) => _outbox.retry(message.clientMessageId);

  Future<void> discard(PendingMessage message) => _outbox.discard(message.clientMessageId);

  /// The composer changed: typing on (throttled), off after a pause.
  void onComposerChanged(String text) {
    if (text.trim().isEmpty) {
      _stopTyping();
      return;
    }
    final now = DateTime.now();
    if (_lastTypingSent == null || now.difference(_lastTypingSent!) >= _typingResend) {
      _realtime.sendTyping(conversationId, isTyping: true);
      _lastTypingSent = now;
    }
    _typingIdleTimer?.cancel();
    _typingIdleTimer = Timer(_typingIdle, _stopTyping);
  }

  void _stopTyping() {
    _typingIdleTimer?.cancel();
    if (_lastTypingSent == null) return;
    _lastTypingSent = null;
    _realtime.sendTyping(conversationId, isTyping: false);
  }

  // ---- history -------------------------------------------------------------

  Future<void> loadOlder() async {
    final current = state.value;
    if (current == null || !current.hasOlder || current.messages.isEmpty) return;
    final page = await _api.history(conversationId, before: current.messages.first.id);
    state = AsyncData(
      current.copyWith(
        messages: [...page.items.reversed, ...current.messages],
        hasOlder: page.hasMore,
      ),
    );
  }

  // ---- menu ----------------------------------------------------------------

  Future<void> setBlocked({required bool blocked}) async {
    final fresh = await _api.setBlocked(conversationId, blocked: blocked);
    final current = state.value;
    if (current != null) state = AsyncData(current.copyWith(conversation: fresh));
  }

  Future<void> report(String reasonCode, String? text) => _api.report(conversationId, reasonCode, text);

  // ---- live ------------------------------------------------------------------

  /// A message from the server (the socket, or the outbox's answer): added
  /// once (by id), replacing my pending copy (by client id).
  void _accept(ChatMessage message, {required bool fromOthers}) {
    final current = state.value;
    if (current == null) return;
    if (current.messages.any((m) => m.id == message.id)) return;
    final messages = [...current.messages, message]..sort((a, b) => a.id.compareTo(b.id));
    final pending = [
      for (final p in current.pending)
        if (p.clientMessageId != message.clientMessageId) p,
    ];
    state = AsyncData(current.copyWith(messages: messages, pending: pending, typing: false));
    if (fromOthers && !current.isMine(message)) {
      unawaited(_api.markDelivered(conversationId, message.id).catchError((Object _) {}));
      _markRead(messages, current.conversation);
    }
  }

  void _onPending(List<PendingMessage> pending) {
    final current = state.value;
    if (current == null) return;
    // A pending row that is already a message (the answer came first) is not shown twice.
    final sentIds = {for (final m in current.messages) m.clientMessageId};
    state = AsyncData(
      current.copyWith(pending: [for (final p in pending) if (!sentIds.contains(p.clientMessageId)) p]),
    );
  }

  void _onReceipt(ReceiptSignal receipt) {
    final current = state.value;
    if (current == null || receipt.memberId == current.conversation.myMemberId) return;
    state = AsyncData(
      current.copyWith(
        conversation: current.conversation.copyWith(
          othersDeliveredUpTo: _later(current.conversation.othersDeliveredUpTo, receipt.deliveredUpTo),
          othersReadUpTo: _later(current.conversation.othersReadUpTo, receipt.readUpTo),
        ),
      ),
    );
  }

  void _onTyping(TypingSignal signal) {
    final current = state.value;
    if (current == null || signal.memberId == current.conversation.myMemberId) return;
    _typingExpiry?.cancel();
    if (signal.isTyping) _typingExpiry = Timer(signal.expiresIn, () => _setTyping(false));
    _setTyping(signal.isTyping);
  }

  void _setTyping(bool typing) {
    final current = state.value;
    if (current != null && current.typing != typing) state = AsyncData(current.copyWith(typing: typing));
  }

  Future<void> _join() async {
    final every = await _realtime.join(conversationId);
    _heartbeat?.cancel();
    if (every != null) {
      _heartbeat = Timer.periodic(every, (_) => _realtime.heartbeat(conversationId));
    }
  }

  /// After a reconnect: join again, fetch what came meanwhile, and the latest state.
  Future<void> _onReconnect() async {
    unawaited(_join());
    final current = state.value;
    if (current == null) return;
    try {
      final after = current.messages.isEmpty ? null : current.messages.last.id;
      final missed = await _api.history(conversationId, after: after);
      for (final m in missed.items) {
        _accept(m, fromOthers: true);
      }
      await _refresh();
    } on Object {
      // Offline again: the next reconnect tries.
    }
  }

  Future<void> _refresh() async {
    try {
      final fresh = await _api.conversation(conversationId);
      final current = state.value;
      if (current != null) state = AsyncData(current.copyWith(conversation: fresh));
    } on Object {
      // Keep what's shown.
    }
  }

  /// Read up to the newest message from the other side (the inbox badge follows).
  void _markRead(List<ChatMessage> messages, Conversation conversation) {
    final theirs = messages.where((m) => m.senderMemberId != conversation.myMemberId);
    if (theirs.isEmpty) return;
    unawaited(_api.markRead(conversationId, theirs.last.id).catchError((Object _) {}));
    scheduleMicrotask(() => ref.read(chatInboxProvider(false).notifier).markSeen(conversationId));
  }

  static String? _later(String? a, String? b) {
    if (a == null) return b;
    if (b == null) return a;
    return a.compareTo(b) >= 0 ? a : b;
  }
}

final conversationProvider = AsyncNotifierProvider.autoDispose
    .family<ConversationController, ConversationState, String>(ConversationController.new);
