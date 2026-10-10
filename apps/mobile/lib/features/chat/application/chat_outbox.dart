import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/connectivity_provider.dart';
import '../../../core/storage/app_database.dart';
import '../../../core/storage/app_database_provider.dart';
import '../../media_upload/data/image_compressor.dart';
import '../data/chat_api.dart';
import '../data/chat_models.dart';

/// A random client message id: URL-safe, 22 characters (the API takes 8–64).
String newClientMessageId([Random? random]) {
  final r = random ?? Random.secure();
  final bytes = List<int>.generate(16, (_) => r.nextInt(256));
  return base64Url.encode(bytes).replaceAll('=', '');
}

/// A message on its way, as the thread shows it until the server has it.
class PendingMessage {
  const PendingMessage({
    required this.clientMessageId,
    required this.conversationId,
    required this.draft,
    required this.failed,
    required this.createdAt,
    this.localImagePath,
    this.errorCode,
  });

  factory PendingMessage.fromRow(PendingChatMessageRow row) => PendingMessage(
    clientMessageId: row.clientMessageId,
    conversationId: row.conversationId,
    draft: MessageDraft.fromJson(jsonDecode(row.contentJson) as Map<String, dynamic>),
    failed: row.state == 'failed',
    createdAt: row.createdAt,
    localImagePath: row.localImagePath,
    errorCode: row.errorCode,
  );

  final String clientMessageId;
  final String conversationId;
  final MessageDraft draft;

  /// Refused for good (blocked, the contact soft-block…): the user decides.
  final bool failed;
  final DateTime createdAt;
  final String? localImagePath;
  final String? errorCode;
}

/// Sends whatever the composer wrote (ADR 060), even offline:
///
///  1. the message goes into the Drift table first (pending — a clock tick);
///  2. sends run one at a time, oldest first, through REST; a photo is
///     compressed and uploaded through the conversation's own media path
///     first;
///  3. no network, a timeout, 5xx or 429: it stays pending and is retried
///     with backoff, as soon as the network comes back, and on the next start;
///  4. a definite refusal (CHAT_CONTACT_INFO_BLOCKED, CHAT_BLOCKED,
///     CHAT_LOCKED…): failed, with its code — the thread says why and offers
///     to edit, retry or discard.
/// The client id is the server's dedupe key, so a replay after a crash or a
/// lost answer never sends a message twice.
class ChatOutbox {
  ChatOutbox({
    required this._db,
    required this._api,
    required this._compressor,
    Future<Directory> Function()? tempDir,
  }) : _tempDir = tempDir ?? getTemporaryDirectory;

  final AppDatabase _db;
  final ChatApi _api;
  final ImageCompressor _compressor;
  final Future<Directory> Function() _tempDir;

  static const _maxBackoff = Duration(minutes: 1);

  final _sent = StreamController<SendResult>.broadcast();
  Timer? _retryTimer;
  Future<void>? _flushing;

  /// Every message the server accepted (the thread swaps its pending copy).
  Stream<SendResult> get sent => _sent.stream;

  Stream<List<PendingMessage>> watch(String conversationId) {
    final query = _db.select(_db.pendingChatMessages)
      ..where((t) => t.conversationId.equals(conversationId))
      ..orderBy([(t) => OrderingTerm.asc(t.createdAt)]);
    return query.watch().map((rows) => rows.map(PendingMessage.fromRow).toList());
  }

  /// Queues a message and starts sending. Returns its client id.
  Future<String> enqueue(String conversationId, MessageDraft draft, {String? localImagePath}) async {
    final id = newClientMessageId();
    await _db
        .into(_db.pendingChatMessages)
        .insert(
          PendingChatMessagesCompanion.insert(
            clientMessageId: id,
            conversationId: conversationId,
            contentJson: jsonEncode(draft.toJson()),
            localImagePath: Value(localImagePath),
            createdAt: DateTime.now(),
          ),
        );
    unawaited(flush());
    return id;
  }

  Future<void> retry(String clientMessageId) async {
    await (_db.update(_db.pendingChatMessages)
          ..where((t) => t.clientMessageId.equals(clientMessageId)))
        .write(const PendingChatMessagesCompanion(state: Value('pending'), errorCode: Value(null)));
    unawaited(flush());
  }

  Future<void> discard(String clientMessageId) async {
    await (_db.delete(_db.pendingChatMessages)
          ..where((t) => t.clientMessageId.equals(clientMessageId)))
        .go();
  }

  /// Sends what's pending (one flush at a time; concurrent calls share it).
  Future<void> flush() => _flushing ??= _flush().whenComplete(() => _flushing = null);

  Future<void> _flush() async {
    _retryTimer?.cancel();
    while (true) {
      final next =
          await (_db.select(_db.pendingChatMessages)
                ..where((t) => t.state.equals('pending'))
                ..orderBy([(t) => OrderingTerm.asc(t.createdAt)])
                ..limit(1))
              .getSingleOrNull();
      if (next == null) return;
      final outcome = await _sendOne(next);
      if (outcome == _Outcome.retryLater) {
        _scheduleRetry(next.attempts + 1);
        return;
      }
    }
  }

  Future<_Outcome> _sendOne(PendingChatMessageRow row) async {
    try {
      var draft = MessageDraft.fromJson(jsonDecode(row.contentJson) as Map<String, dynamic>);
      if (draft is ImageDraft && draft.mediaId == null && row.localImagePath != null) {
        final mediaId = await _upload(row.conversationId, row.localImagePath!);
        draft = ImageDraft(mediaId);
        await _update(row.clientMessageId, contentJson: jsonEncode(draft.toJson()));
      }
      final result = await _api.send(row.conversationId, row.clientMessageId, draft);
      await discard(row.clientMessageId);
      _sent.add(result);
      return _Outcome.done;
    } on ApiException catch (e) {
      final status = e.body.statusCode;
      // 401: signed out or a session to renew — the message waits for the user, it isn't refused.
      final transient = status >= 500 || status == 429 || status == 408 || status == 401;
      if (transient) {
        await _update(row.clientMessageId, attempts: row.attempts + 1);
        return _Outcome.retryLater;
      }
      await _update(row.clientMessageId, state: 'failed', errorCode: e.code);
      return _Outcome.done;
    } on ChatImageRejected {
      await _update(row.clientMessageId, state: 'failed', errorCode: 'CHAT_IMAGE_INVALID');
      return _Outcome.done;
    } on Object {
      // Offline, a timeout, a photo still processing: later.
      await _update(row.clientMessageId, attempts: row.attempts + 1);
      return _Outcome.retryLater;
    }
  }

  Future<String> _upload(String conversationId, String path) async {
    final dir = await _tempDir();
    final target = '${dir.path}/chat-${DateTime.now().microsecondsSinceEpoch}.webp';
    await _compressor.compress(path, target);
    final file = File(target);
    try {
      return await _api.uploadImage(conversationId, file);
    } finally {
      if (file.existsSync()) unawaited(file.delete());
    }
  }

  Future<void> _update(
    String clientMessageId, {
    String? contentJson,
    String? state,
    String? errorCode,
    int? attempts,
  }) => (_db.update(_db.pendingChatMessages)..where((t) => t.clientMessageId.equals(clientMessageId)))
      .write(
        PendingChatMessagesCompanion(
          contentJson: contentJson == null ? const Value.absent() : Value(contentJson),
          state: state == null ? const Value.absent() : Value(state),
          errorCode: errorCode == null ? const Value.absent() : Value(errorCode),
          attempts: attempts == null ? const Value.absent() : Value(attempts),
        ),
      );

  /// 2, 4, 8 … seconds, at most a minute; the network coming back flushes sooner.
  void _scheduleRetry(int attempts) {
    final seconds = min(pow(2, attempts).toInt(), _maxBackoff.inSeconds);
    _retryTimer?.cancel();
    _retryTimer = Timer(Duration(seconds: seconds), () => unawaited(flush()));
  }

  void dispose() {
    _retryTimer?.cancel();
    unawaited(_sent.close());
  }
}

enum _Outcome { done, retryLater }

final chatOutboxProvider = Provider<ChatOutbox>((ref) {
  final outbox = ChatOutbox(
    db: ref.watch(appDatabaseProvider),
    api: ref.watch(chatApiProvider),
    compressor: PluginImageCompressor(),
  );
  // Back online: send what waited.
  ref.listen(isOnlineProvider, (previous, next) {
    if (next.value == true && previous?.value != true) unawaited(outbox.flush());
  });
  ref.onDispose(outbox.dispose);
  // What waited from the last run (written offline, or the app was killed).
  unawaited(outbox.flush());
  return outbox;
});
