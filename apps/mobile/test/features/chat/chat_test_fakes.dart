import 'dart:async';
import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/chat/data/chat_api.dart';
import 'package:amar_elaka_app/features/chat/data/chat_models.dart';
import 'package:amar_elaka_app/features/chat/data/chat_realtime.dart';
import 'package:amar_elaka_app/features/notifications/data/notification_settings_api.dart';
import 'package:amar_elaka_app/features/notifications/push/push_messaging.dart';

/// Message ids as the API makes them: uuid v7, so text order is time order.
String messageId(int n) => '0192a000-0000-7000-8000-${n.toString().padLeft(12, '0')}';

/// The buyer (the signed-in test user, member m1) and the seller.
const buyerMemberId = 'm1';
const sellerMemberId = 'm2';

Map<String, dynamic> conversationJson({
  String id = 'c1',
  String myMemberId = buyerMemberId,
  String myRole = 'buyer',
  String counterpartKind = 'seller',
  String? counterpartName = 'রহিম মিয়া',
  int unreadCount = 0,
  bool isArchived = false,
  bool isLocked = false,
  bool isBlocked = false,
  bool blockedByMe = false,
  String? othersDeliveredUpTo,
  String? othersReadUpTo,
  Map<String, dynamic>? lastMessage,
  Map<String, dynamic>? store,
  String postTitle = 'আইফোন ১৩ প্রো — ১২৮ জিবি, প্রায় নতুন',
}) => {
  'id': id,
  'tenantId': 't1',
  'post': {
    'id': 'p1',
    'title': postTitle,
    'price': '65000.00',
    'cover': null,
  },
  'postRemoved': false,
  'store': store,
  'counterpart': {'kind': counterpartKind, 'name': counterpartName},
  'me': {'memberId': myMemberId, 'role': myRole},
  'unreadCount': unreadCount,
  'isArchived': isArchived,
  'isLocked': isLocked,
  'isBlocked': isBlocked,
  'blockedByMe': blockedByMe,
  'canSend': !isLocked && !isBlocked,
  'othersDeliveredUpTo': othersDeliveredUpTo,
  'othersReadUpTo': othersReadUpTo,
  'lastMessage': lastMessage,
  'activityAt': '2026-10-09T08:00:00.000Z',
};

Conversation conversation({
  String id = 'c1',
  String myMemberId = buyerMemberId,
  String myRole = 'buyer',
  String counterpartKind = 'seller',
  int unreadCount = 0,
  String? othersDeliveredUpTo,
  String? othersReadUpTo,
  ChatMessage? lastMessage,
  bool isLocked = false,
}) => Conversation.fromJson(
  conversationJson(
    id: id,
    myMemberId: myMemberId,
    myRole: myRole,
    counterpartKind: counterpartKind,
    unreadCount: unreadCount,
    othersDeliveredUpTo: othersDeliveredUpTo,
    othersReadUpTo: othersReadUpTo,
    isLocked: isLocked,
  ),
).copyWith(lastMessage: lastMessage);

Map<String, dynamic> messageJson({
  required int n,
  String conversationId = 'c1',
  String? sender = buyerMemberId,
  String kind = 'text',
  String? body,
  String? clientMessageId,
  DateTime? at,
}) => {
  'id': messageId(n),
  'conversationId': conversationId,
  'clientMessageId': clientMessageId ?? 'client-$n',
  'senderMemberId': sender,
  'kind': kind,
  'body': body,
  'image': null,
  'location': null,
  'listing': null,
  'systemEvent': null,
  'createdAt': (at ?? DateTime.utc(2026, 10, 9, 8, n)).toIso8601String(),
};

ChatMessage message({
  required int n,
  String conversationId = 'c1',
  String? sender = buyerMemberId,
  String? body,
  DateTime? at,
}) => ChatMessage.fromJson(
  messageJson(n: n, conversationId: conversationId, sender: sender, body: body, at: at),
);

ApiException chatApiError(int status, String code) =>
    ApiException(ApiErrorBody(statusCode: status, error: code, message: code));

/// The chat REST API in memory: conversations, their messages, what was sent.
/// A send dedupes on the client id, as the server does.
class FakeChatApi implements ChatApi {
  FakeChatApi({Map<String, Map<String, dynamic>>? conversations})
    : conversations = conversations ?? {'c1': conversationJson()};

  final Map<String, Map<String, dynamic>> conversations;
  final messages = <String, List<ChatMessage>>{};
  final sent = <(String conversationId, String clientMessageId, MessageDraft draft)>[];
  final opened = <(String? postId, String? storeId)>[];
  final archived = <(String, bool)>[];
  final reads = <(String, String)>[];

  /// The next sends fail with these, in order (null: the network is down).
  final sendFailures = <ApiException?>[];
  int _next = 100;

  /// A message from the other side, as the server would have stored it.
  ChatMessage receive(String conversationId, String body, {String sender = sellerMemberId}) {
    final m = message(n: _next++, conversationId: conversationId, sender: sender, body: body);
    (messages[conversationId] ??= []).add(m);
    return m;
  }

  @override
  Future<({Conversation conversation, bool created})> openForPost(String postId, ChatSource source) async {
    opened.add((postId, null));
    return (conversation: Conversation.fromJson(conversations.values.first), created: true);
  }

  @override
  Future<({Conversation conversation, bool created})> openForStore(String storeId) async {
    opened.add((null, storeId));
    return (conversation: Conversation.fromJson(conversations.values.first), created: true);
  }

  @override
  Future<InboxResult> inbox({String? cursor, bool archived = false}) async => InboxResult(
    items: [
      for (final c in conversations.values)
        if (c['isArchived'] == archived) Conversation.fromJson(c),
    ],
  );

  @override
  Future<Conversation> conversation(String id) async => Conversation.fromJson(conversations[id]!);

  @override
  Future<HistoryResult> history(String id, {String? before, String? after}) async {
    final all = messages[id] ?? const <ChatMessage>[];
    final items = after != null
        ? all.where((m) => m.id.compareTo(after) > 0).toList()
        : all.reversed.toList();
    return HistoryResult(items: items, hasMore: false);
  }

  @override
  Future<SendResult> send(String conversationId, String clientMessageId, MessageDraft draft) async {
    if (sendFailures.isNotEmpty) {
      final failure = sendFailures.removeAt(0);
      throw failure ?? const NetworkException();
    }
    final list = messages[conversationId] ??= [];
    final existing = list.where((m) => m.clientMessageId == clientMessageId).firstOrNull;
    if (existing != null) return SendResult(message: existing, created: false);
    sent.add((conversationId, clientMessageId, draft));
    final me = conversations[conversationId]!['me'] as Map<String, dynamic>;
    final m = ChatMessage.fromJson({
      ...messageJson(n: _next++, conversationId: conversationId, sender: me['memberId'] as String),
      'clientMessageId': clientMessageId,
      'body': draft is TextDraft ? draft.body : null,
    });
    list.add(m);
    return SendResult(message: m, created: true);
  }

  @override
  Future<void> markRead(String conversationId, String upToMessageId) async =>
      reads.add((conversationId, upToMessageId));

  @override
  Future<void> markDelivered(String conversationId, String upToMessageId) async {}

  @override
  Future<Conversation> setArchived(String conversationId, {required bool archived}) async {
    this.archived.add((conversationId, archived));
    conversations[conversationId] = {...conversations[conversationId]!, 'isArchived': archived};
    return Conversation.fromJson(conversations[conversationId]!);
  }

  @override
  Future<Conversation> setBlocked(String conversationId, {required bool blocked}) async {
    conversations[conversationId] = {
      ...conversations[conversationId]!,
      'isBlocked': blocked,
      'blockedByMe': blocked,
      'canSend': !blocked,
    };
    return Conversation.fromJson(conversations[conversationId]!);
  }

  @override
  Future<void> report(String conversationId, String reasonCode, String? text) async {}

  @override
  Future<List<QuickReply>> quickReplies(String conversationId) async => const [];

  @override
  Future<String> uploadImage(String conversationId, File file) async => 'media-1';
}

/// The socket, driven by the test.
class FakeChatRealtime implements ChatRealtime {
  final _messages = StreamController<IncomingMessage>.broadcast();
  final _receipts = StreamController<ReceiptSignal>.broadcast();
  final _typing = StreamController<TypingSignal>.broadcast();
  final _updated = StreamController<String>.broadcast();
  final _connected = StreamController<bool>.broadcast();
  final joined = <String>[];
  final typingSent = <bool>[];

  void deliver(ChatMessage m) => _messages.add(IncomingMessage('t1', m));
  void typingFrom(String conversationId, {required bool isTyping}) => _typing.add(
    TypingSignal(
      conversationId: conversationId,
      memberId: sellerMemberId,
      isTyping: isTyping,
      expiresIn: const Duration(seconds: 5),
    ),
  );

  @override
  Stream<IncomingMessage> get messages => _messages.stream;
  @override
  Stream<ReceiptSignal> get receipts => _receipts.stream;
  @override
  Stream<TypingSignal> get typing => _typing.stream;
  @override
  Stream<String> get conversationUpdated => _updated.stream;
  @override
  Stream<bool> get connected => _connected.stream;
  @override
  Future<void> start() async {}
  @override
  Future<void> stop() async {}
  @override
  Future<Duration?> join(String conversationId) async {
    joined.add(conversationId);
    return null;
  }

  @override
  void heartbeat(String conversationId) {}
  @override
  void leave(String conversationId) => joined.remove(conversationId);
  @override
  void sendTyping(String conversationId, {required bool isTyping}) => typingSent.add(isTyping);
}

/// FCM, driven by the test: permission, the token, pushes arriving and tapped.
class FakePushMessaging implements PushMessaging {
  FakePushMessaging({this.current = PushPermission.notAsked, this.answer = PushPermission.granted});

  PushPermission current;
  PushPermission answer;
  int prompts = 0;
  final _foreground = StreamController<PushPayload>.broadcast();
  final _opened = StreamController<PushPayload>.broadcast();

  void arriveInForeground(PushPayload p) => _foreground.add(p);
  void tap(PushPayload p) => _opened.add(p);

  @override
  bool get isAvailable => true;
  @override
  Future<PushPermission> permission() async => current;
  @override
  Future<PushPermission> requestPermission() async {
    prompts++;
    return current = answer;
  }

  @override
  Future<String?> token() async => 'fcm-token-1';
  @override
  Stream<String> get tokenRefreshed => const Stream.empty();
  @override
  Stream<PushPayload> get foreground => _foreground.stream;
  @override
  Stream<PushPayload> get opened => _opened.stream;
  @override
  Future<PushPayload?> initialMessage() async => null;
}

class FakeNotificationSettingsApi implements NotificationSettingsApi {
  final registered = <(String platform, String token)>[];

  @override
  Future<List<TypePreference>> preferences() async => const [];
  @override
  Future<List<TypePreference>> setPreference(String type, String channel, {required bool enabled}) async =>
      const [];
  @override
  Future<void> registerPushToken(String platform, String token) async => registered.add((platform, token));
  @override
  Future<void> forgetPushToken(String token) async {}
}
