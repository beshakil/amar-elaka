import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import 'chat_models.dart';

class InboxResult {
  const InboxResult({required this.items, this.nextCursor});
  final List<Conversation> items;
  final String? nextCursor;
}

class HistoryResult {
  const HistoryResult({required this.items, required this.hasMore});

  /// Newest first for `before` (or none), oldest first for `after`.
  final List<ChatMessage> items;
  final bool hasMore;
}

class SendResult {
  const SendResult({required this.message, required this.created});
  final ChatMessage message;

  /// False: the server already had this client id (a replay) — nothing new.
  final bool created;
}

/// Where a conversation was opened from (lead_sources): the chat lead's source.
enum ChatSource { postDetail, storePage, searchResult }

/// Chat over REST (apps/api/src/chat/chat.controller.ts). Everything the
/// socket does is here too, so the app works without one; sending always
/// goes through here (the outbox), the socket only listens and types.
abstract interface class ChatApi {
  Future<({Conversation conversation, bool created})> openForPost(
    String postId,
    ChatSource source,
  );
  Future<({Conversation conversation, bool created})> openForStore(
    String storeId,
  );
  Future<InboxResult> inbox({String? cursor, bool archived = false});
  Future<Conversation> conversation(String id);
  Future<HistoryResult> history(String id, {String? before, String? after});
  Future<SendResult> send(
    String conversationId,
    String clientMessageId,
    MessageDraft draft,
  );
  Future<void> markRead(String conversationId, String upToMessageId);
  Future<void> markDelivered(String conversationId, String upToMessageId);
  Future<Conversation> setArchived(
    String conversationId, {
    required bool archived,
  });
  Future<Conversation> setBlocked(
    String conversationId, {
    required bool blocked,
  });
  Future<void> report(String conversationId, String reasonCode, String? text);
  Future<List<QuickReply>> quickReplies(String conversationId);

  /// Uploads a (compressed) photo for this conversation; returns its media id once ready.
  Future<String> uploadImage(String conversationId, File file);
}

class DioChatApi implements ChatApi {
  DioChatApi(this._dio);

  final Dio _dio;

  /// How long to wait for the worker to process an uploaded photo.
  static const _imageReadyPolls = 20;
  static const _imageReadyInterval = Duration(milliseconds: 750);

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  static String _source(ChatSource source) => switch (source) {
    ChatSource.postDetail => 'post_detail',
    ChatSource.storePage => 'store_page',
    ChatSource.searchResult => 'search_result',
  };

  static ({Conversation conversation, bool created}) _opened(
    Map<String, dynamic> json,
  ) => (
    conversation: Conversation.fromJson(
      json['conversation'] as Map<String, dynamic>,
    ),
    created: json['created'] as bool,
  );

  @override
  Future<({Conversation conversation, bool created})> openForPost(
    String postId,
    ChatSource source,
  ) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/posts/$postId/conversations',
      data: {'source': _source(source)},
    );
    return _opened(r.data!);
  });

  @override
  Future<({Conversation conversation, bool created})> openForStore(
    String storeId,
  ) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/stores/$storeId/conversations',
      data: {'source': 'store_page'},
    );
    return _opened(r.data!);
  });

  @override
  Future<InboxResult> inbox({String? cursor, bool archived = false}) => _call(
    () async {
      final r = await _dio.get<Map<String, dynamic>>(
        '/conversations',
        queryParameters: {'cursor': ?cursor, if (archived) 'archived': 'true'},
      );
      final data = r.data!;
      return InboxResult(
        items: [
          for (final c in data['items'] as List)
            Conversation.fromJson(c as Map<String, dynamic>),
        ],
        nextCursor: data['nextCursor'] as String?,
      );
    },
  );

  @override
  Future<Conversation> conversation(String id) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/conversations/$id');
    return Conversation.fromJson(r.data!);
  });

  @override
  Future<HistoryResult> history(String id, {String? before, String? after}) =>
      _call(() async {
        final r = await _dio.get<Map<String, dynamic>>(
          '/conversations/$id/messages',
          queryParameters: {'before': ?before, 'after': ?after},
        );
        final data = r.data!;
        return HistoryResult(
          items: [
            for (final m in data['items'] as List)
              ChatMessage.fromJson(m as Map<String, dynamic>),
          ],
          hasMore: data['hasMore'] as bool,
        );
      });

  @override
  Future<SendResult> send(
    String conversationId,
    String clientMessageId,
    MessageDraft draft,
  ) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/conversations/$conversationId/messages',
      data: {'clientMessageId': clientMessageId, 'content': draft.toJson()},
    );
    return SendResult(
      message: ChatMessage.fromJson(r.data!['message'] as Map<String, dynamic>),
      created: r.data!['created'] as bool,
    );
  });

  @override
  Future<void> markRead(String conversationId, String upToMessageId) =>
      _call(() async {
        await _dio.post<void>(
          '/conversations/$conversationId/read',
          data: {'upToMessageId': upToMessageId},
        );
      });

  @override
  Future<void> markDelivered(String conversationId, String upToMessageId) =>
      _call(() async {
        await _dio.post<void>(
          '/conversations/$conversationId/delivered',
          data: {'upToMessageId': upToMessageId},
        );
      });

  @override
  Future<Conversation> setArchived(
    String conversationId, {
    required bool archived,
  }) => _call(() async {
    final path = '/conversations/$conversationId/archive';
    final r = archived
        ? await _dio.post<Map<String, dynamic>>(path)
        : await _dio.delete<Map<String, dynamic>>(path);
    return Conversation.fromJson(r.data!);
  });

  @override
  Future<Conversation> setBlocked(
    String conversationId, {
    required bool blocked,
  }) => _call(() async {
    final path = '/conversations/$conversationId/block';
    final r = blocked
        ? await _dio.post<Map<String, dynamic>>(path)
        : await _dio.delete<Map<String, dynamic>>(path);
    return Conversation.fromJson(r.data!);
  });

  @override
  Future<void> report(String conversationId, String reasonCode, String? text) =>
      _call(() async {
        await _dio.post<void>(
          '/conversations/$conversationId/report',
          data: {
            'reasonCode': reasonCode,
            if (text != null && text.trim().isNotEmpty) 'text': text,
          },
        );
      });

  @override
  Future<List<QuickReply>> quickReplies(String conversationId) =>
      _call(() async {
        final r = await _dio.get<Map<String, dynamic>>(
          '/conversations/$conversationId/quick-replies',
        );
        return [
          for (final q in r.data!['items'] as List)
            QuickReply.fromJson(q as Map<String, dynamic>),
        ];
      });

  @override
  Future<String> uploadImage(String conversationId, File file) =>
      _call(() async {
        final bytes = await file.readAsBytes();
        final presigned = await _dio.post<Map<String, dynamic>>(
          '/conversations/$conversationId/images',
          data: {
            'contentType': 'image/webp',
            'byteSize': bytes.length,
            'checksumSha256': sha256.convert(bytes).toString(),
          },
        );
        final mediaId = presigned.data!['mediaId'] as String;
        final upload = presigned.data!['upload'] as Map<String, dynamic>;
        await Dio().put<void>(
          upload['url'] as String,
          data: Stream.fromIterable([bytes]),
          options: Options(
            headers: {
              ...(upload['headers'] as Map<String, dynamic>),
              Headers.contentLengthHeader: bytes.length,
            },
          ),
        );
        await _dio.post<void>(
          '/conversations/$conversationId/images/$mediaId/confirm',
        );
        for (var i = 0; i < _imageReadyPolls; i++) {
          final status = await _dio.get<Map<String, dynamic>>(
            '/conversations/$conversationId/images/$mediaId',
          );
          switch (status.data!['status']) {
            case 'ready':
              return mediaId;
            case 'rejected':
            case 'quarantined':
              throw const ChatImageRejected();
          }
          await Future<void>.delayed(_imageReadyInterval);
        }
        throw const ChatImageNotReady();
      });
}

/// The worker refused the photo (not an image, too big after all).
class ChatImageRejected implements Exception {
  const ChatImageRejected();
}

/// The photo is still processing: the outbox tries again later.
class ChatImageNotReady implements Exception {
  const ChatImageNotReady();
}

final chatApiProvider = Provider<ChatApi>(
  (ref) => DioChatApi(ref.watch(dioClientProvider)),
);
