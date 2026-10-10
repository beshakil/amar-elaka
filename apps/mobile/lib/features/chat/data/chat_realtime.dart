import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import '../../../core/network/api_config.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/storage/secure_session_storage.dart';
import 'chat_models.dart';

/// A message arrived (mine from another device, or theirs).
class IncomingMessage {
  const IncomingMessage(this.tenantId, this.message);
  final String tenantId;
  final ChatMessage message;
}

/// The chat socket (apps/api/src/chat/realtime, ADR 058) as the app uses it:
/// it listens (messages, receipts, typing, a conversation that changed) and
/// sends the ephemeral bits (typing, presence, receipts). Messages go out
/// through REST, via the outbox, so a send never depends on the socket.
abstract interface class ChatRealtime {
  Stream<IncomingMessage> get messages;
  Stream<ReceiptSignal> get receipts;
  Stream<TypingSignal> get typing;

  /// A conversation changed elsewhere (blocked, locked, archived): fetch it again.
  Stream<String> get conversationUpdated;

  /// True while connected; every reconnect is a cue to catch up.
  Stream<bool> get connected;

  Future<void> start();
  Future<void> stop();

  /// Opening a thread: typing reaches it, and its pushes stay quiet while open.
  /// Returns how often to call [heartbeat] (null when not connected).
  Future<Duration?> join(String conversationId);
  void heartbeat(String conversationId);
  void leave(String conversationId);
  void sendTyping(String conversationId, {required bool isTyping});
}

/// The Socket.IO client. One per app session (signed in), started by the
/// inbox or a thread, kept while the app runs.
///
///  - WebSocket only (the server takes nothing else);
///  - the access token is read on every (re)connect, so a refreshed session
///    simply rides along;
///  - `auth:expired` (the token ran out with the socket open): one cheap
///    authenticated REST call lets the refresh interceptor renew the token,
///    then reconnect;
///  - reconnects with backoff; each `connect` is announced on [connected] so
///    open screens fetch what they missed (`?after=`).
class SocketIoChatRealtime implements ChatRealtime {
  SocketIoChatRealtime({required this._storage, required this._dio});

  final SecureSessionStorage _storage;
  final Dio _dio;
  io.Socket? _socket;

  static const _path = '/api/v1/chat/socket.io';
  static const _namespace = '/chat';
  static const _reconnectDelayMs = 1000;
  static const _reconnectDelayMaxMs = 30000;

  final _messages = StreamController<IncomingMessage>.broadcast();
  final _receipts = StreamController<ReceiptSignal>.broadcast();
  final _typing = StreamController<TypingSignal>.broadcast();
  final _updated = StreamController<String>.broadcast();
  final _connected = StreamController<bool>.broadcast();

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

  /// The server's origin: the API base URL without its /api/v1 path.
  static String get _origin {
    final base = Uri.parse(ApiConfig.baseUrl);
    return base.replace(path: '', query: null).toString().replaceAll(RegExp(r'/$'), '');
  }

  @override
  Future<void> start() async {
    if (_socket != null) return;
    final socket = io.io('$_origin$_namespace', <String, dynamic>{
      'path': _path,
      'transports': ['websocket'],
      'autoConnect': false,
      'forceNew': true,
      'reconnection': true,
      'reconnectionDelay': _reconnectDelayMs,
      'reconnectionDelayMax': _reconnectDelayMaxMs,
      // Read at every (re)connect: a refreshed token is picked up as is.
      'auth': (void Function(Map<String, dynamic>) cb) {
        unawaited(_storage.readAccessToken().then((token) => cb({'token': token ?? ''})));
      },
    });
    socket
      ..onConnect((_) => _connected.add(true))
      ..onDisconnect((_) => _connected.add(false))
      ..on('message:new', (data) {
        final map = _map(data);
        if (map == null) return;
        _messages.add(
          IncomingMessage(
            map['tenantId'] as String,
            ChatMessage.fromJson(map['message'] as Map<String, dynamic>),
          ),
        );
      })
      ..on('receipt', (data) {
        final map = _map(data);
        if (map == null) return;
        _receipts.add(
          ReceiptSignal(
            conversationId: map['conversationId'] as String,
            memberId: map['memberId'] as String,
            deliveredUpTo: map['deliveredUpTo'] as String?,
            readUpTo: map['readUpTo'] as String?,
          ),
        );
      })
      ..on('typing', (data) {
        final map = _map(data);
        if (map == null) return;
        _typing.add(
          TypingSignal(
            conversationId: map['conversationId'] as String,
            memberId: map['memberId'] as String,
            isTyping: map['isTyping'] as bool,
            expiresIn: Duration(seconds: (map['expiresInSeconds'] as num).toInt()),
          ),
        );
      })
      ..on('conversation:updated', (data) {
        final id = _map(data)?['conversationId'];
        if (id is String) _updated.add(id);
      })
      ..on('auth:expired', (_) => unawaited(_renewAndReconnect()))
      ..onConnectError((error) {
        // UNAUTHENTICATED: the stored token is stale — renew once, then retry.
        if (error is Map && (error['data'] as Map?)?['code'] == 'UNAUTHENTICATED') {
          unawaited(_renewAndReconnect());
        }
      });
    _socket = socket..connect();
  }

  bool _renewing = false;

  Future<void> _renewAndReconnect() async {
    if (_renewing) return;
    _renewing = true;
    try {
      // Any authenticated call: the refresh interceptor renews an expired token.
      await _dio.get<void>('/notifications/unread-count');
    } on Object {
      // Offline or signed out: the socket's own reconnection retries later.
    } finally {
      _renewing = false;
    }
    final socket = _socket;
    if (socket != null && !socket.connected) socket.connect();
  }

  @override
  Future<void> stop() async {
    _socket?.dispose();
    _socket = null;
  }

  @override
  Future<Duration?> join(String conversationId) async {
    final socket = _socket;
    if (socket == null || !socket.connected) return null;
    final answer = await socket
        .emitWithAckAsync('conversation:join', {'conversationId': conversationId})
        .timeout(const Duration(seconds: 10), onTimeout: () => null);
    final data = _map(answer)?['data'];
    final ttl = data is Map ? data['presenceTtlSeconds'] : null;
    // Refresh presence at half its lifetime.
    return ttl is num ? Duration(milliseconds: (ttl * 1000 / 2).round()) : null;
  }

  @override
  void heartbeat(String conversationId) =>
      _socket?.emit('conversation:heartbeat', {'conversationId': conversationId});

  @override
  void leave(String conversationId) =>
      _socket?.emit('conversation:leave', {'conversationId': conversationId});

  @override
  void sendTyping(String conversationId, {required bool isTyping}) =>
      _socket?.emit('typing', {'conversationId': conversationId, 'isTyping': isTyping});

  static Map<String, dynamic>? _map(Object? data) => switch (data) {
    final Map<String, dynamic> m => m,
    final Map m => m.cast<String, dynamic>(),
    final List l when l.isNotEmpty => _map(l.first),
    _ => null,
  };
}

final chatRealtimeProvider = Provider<ChatRealtime>((ref) {
  final realtime = SocketIoChatRealtime(
    storage: ref.watch(secureSessionStorageProvider),
    dio: ref.watch(dioClientProvider),
  );
  ref.onDispose(() => unawaited(realtime.stop()));
  return realtime;
});
