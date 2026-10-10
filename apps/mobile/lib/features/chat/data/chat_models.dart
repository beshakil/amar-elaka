/// Chat as the API sends it (apps/api/src/chat/dto/chat.dto.ts, ADR 058/060).
/// Hand-written like the notification inbox's models: the shapes the app
/// actually reads, nothing more.
library;

/// A post card's cover, or a store's.
class ChatCover {
  const ChatCover({required this.url, this.thumbhash});

  factory ChatCover.fromJson(Map<String, dynamic> json) => ChatCover(
    url: json['url'] as String,
    thumbhash: json['thumbhash'] as String?,
  );

  final String url;
  final String? thumbhash;
}

class ChatPost {
  const ChatPost({
    required this.id,
    required this.title,
    this.price,
    this.cover,
  });

  factory ChatPost.fromJson(Map<String, dynamic> json) => ChatPost(
    id: json['id'] as String,
    title: json['title'] as String,
    price: json['price'] as String?,
    cover: switch (json['cover']) {
      final Map<String, dynamic> c => ChatCover.fromJson(c),
      _ => null,
    },
  );

  final String id;
  final String title;

  /// Money as the API writes it ("12000.00"); null for a post without a price.
  final String? price;
  final ChatCover? cover;
}

class ChatStore {
  const ChatStore({
    required this.id,
    required this.slug,
    required this.nameBn,
    this.nameEn,
  });

  factory ChatStore.fromJson(Map<String, dynamic> json) {
    final name = json['name'] as Map<String, dynamic>;
    return ChatStore(
      id: json['id'] as String,
      slug: json['slug'] as String,
      nameBn: name['bn'] as String,
      nameEn: name['en'] as String?,
    );
  }

  final String id;
  final String slug;
  final String nameBn;
  final String? nameEn;

  String nameFor(String locale) => locale == 'en' ? (nameEn ?? nameBn) : nameBn;
}

enum ParticipantRole { buyer, seller, storeStaff }

ParticipantRole? _role(Object? code) => switch (code) {
  'buyer' => ParticipantRole.buyer,
  'seller' => ParticipantRole.seller,
  'store_staff' => ParticipantRole.storeStaff,
  _ => null,
};

/// One conversation as its participant sees it.
class Conversation {
  const Conversation({
    required this.id,
    required this.tenantId,
    required this.post,
    required this.postRemoved,
    required this.store,
    required this.counterpartKind,
    required this.counterpartName,
    required this.myMemberId,
    required this.myRole,
    required this.unreadCount,
    required this.isArchived,
    required this.isLocked,
    required this.isBlocked,
    required this.blockedByMe,
    required this.canSend,
    required this.othersDeliveredUpTo,
    required this.othersReadUpTo,
    required this.lastMessage,
    required this.activityAt,
  });

  factory Conversation.fromJson(Map<String, dynamic> json) {
    final counterpart = json['counterpart'] as Map<String, dynamic>;
    final me = json['me'] as Map<String, dynamic>;
    return Conversation(
      id: json['id'] as String,
      tenantId: json['tenantId'] as String,
      post: switch (json['post']) {
        final Map<String, dynamic> p => ChatPost.fromJson(p),
        _ => null,
      },
      postRemoved: json['postRemoved'] as bool,
      store: switch (json['store']) {
        final Map<String, dynamic> s => ChatStore.fromJson(s),
        _ => null,
      },
      counterpartKind: counterpart['kind'] as String,
      counterpartName: counterpart['name'] as String?,
      myMemberId: me['memberId'] as String,
      myRole: _role(me['role']) ?? ParticipantRole.buyer,
      unreadCount: json['unreadCount'] as int,
      isArchived: json['isArchived'] as bool,
      isLocked: json['isLocked'] as bool,
      isBlocked: json['isBlocked'] as bool,
      blockedByMe: json['blockedByMe'] as bool,
      canSend: json['canSend'] as bool,
      othersDeliveredUpTo: json['othersDeliveredUpTo'] as String?,
      othersReadUpTo: json['othersReadUpTo'] as String?,
      lastMessage: switch (json['lastMessage']) {
        final Map<String, dynamic> m => ChatMessage.fromJson(m),
        _ => null,
      },
      activityAt: DateTime.parse(json['activityAt'] as String),
    );
  }

  final String id;
  final String tenantId;
  final ChatPost? post;
  final bool postRemoved;
  final ChatStore? store;

  /// buyer | seller | store.
  final String counterpartKind;
  final String? counterpartName;
  final String myMemberId;
  final ParticipantRole myRole;
  final int unreadCount;
  final bool isArchived;
  final bool isLocked;
  final bool isBlocked;
  final bool blockedByMe;
  final bool canSend;
  final String? othersDeliveredUpTo;
  final String? othersReadUpTo;
  final ChatMessage? lastMessage;
  final DateTime activityAt;

  bool get isSellerSide => myRole != ParticipantRole.buyer;

  Conversation copyWith({
    int? unreadCount,
    bool? isArchived,
    String? othersDeliveredUpTo,
    String? othersReadUpTo,
    ChatMessage? lastMessage,
    DateTime? activityAt,
  }) => Conversation(
    id: id,
    tenantId: tenantId,
    post: post,
    postRemoved: postRemoved,
    store: store,
    counterpartKind: counterpartKind,
    counterpartName: counterpartName,
    myMemberId: myMemberId,
    myRole: myRole,
    unreadCount: unreadCount ?? this.unreadCount,
    isArchived: isArchived ?? this.isArchived,
    isLocked: isLocked,
    isBlocked: isBlocked,
    blockedByMe: blockedByMe,
    canSend: canSend,
    othersDeliveredUpTo: othersDeliveredUpTo ?? this.othersDeliveredUpTo,
    othersReadUpTo: othersReadUpTo ?? this.othersReadUpTo,
    lastMessage: lastMessage ?? this.lastMessage,
    activityAt: activityAt ?? this.activityAt,
  );
}

enum MessageKind { text, image, location, listingCard, system }

MessageKind _kind(Object? code) => switch (code) {
  'image' => MessageKind.image,
  'location' => MessageKind.location,
  'listing_card' => MessageKind.listingCard,
  'system' => MessageKind.system,
  _ => MessageKind.text,
};

class ChatImageVariant {
  const ChatImageVariant({
    required this.url,
    required this.width,
    required this.height,
  });

  factory ChatImageVariant.fromJson(Map<String, dynamic> json) =>
      ChatImageVariant(
        url: json['url'] as String,
        width: (json['width'] as num).toInt(),
        height: (json['height'] as num).toInt(),
      );

  final String url;
  final int width;
  final int height;
}

class ChatImage {
  const ChatImage({
    required this.thumb,
    required this.card,
    required this.full,
    this.thumbhash,
  });

  factory ChatImage.fromJson(Map<String, dynamic> json) => ChatImage(
    thumb: ChatImageVariant.fromJson(json['thumb'] as Map<String, dynamic>),
    card: ChatImageVariant.fromJson(json['card'] as Map<String, dynamic>),
    full: ChatImageVariant.fromJson(json['full'] as Map<String, dynamic>),
    thumbhash: json['thumbhash'] as String?,
  );

  final ChatImageVariant thumb;
  final ChatImageVariant card;
  final ChatImageVariant full;
  final String? thumbhash;
}

/// A shared post card, or the neutral marker once the post was removed (Q46).
class ChatListing {
  const ChatListing.shared({
    required this.postId,
    required this.title,
    this.price,
    this.cover,
  }) : removed = false;

  const ChatListing.removed()
    : postId = null,
      title = null,
      price = null,
      cover = null,
      removed = true;

  factory ChatListing.fromJson(Map<String, dynamic> json) =>
      json['state'] == 'shared'
      ? ChatListing.shared(
          postId: json['postId'] as String,
          title: json['title'] as String,
          price: json['price'] as String?,
          cover: switch (json['cover']) {
            final Map<String, dynamic> c => ChatCover.fromJson(c),
            _ => null,
          },
        )
      : const ChatListing.removed();

  final String? postId;
  final String? title;
  final String? price;
  final ChatCover? cover;
  final bool removed;
}

class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.conversationId,
    required this.clientMessageId,
    required this.senderMemberId,
    required this.kind,
    required this.createdAt,
    this.body,
    this.image,
    this.lat,
    this.lng,
    this.listing,
    this.systemEvent,
  });

  factory ChatMessage.fromJson(Map<String, dynamic> json) {
    final location = json['location'] as Map<String, dynamic>?;
    return ChatMessage(
      id: json['id'] as String,
      conversationId: json['conversationId'] as String,
      clientMessageId: json['clientMessageId'] as String,
      senderMemberId: json['senderMemberId'] as String?,
      kind: _kind(json['kind']),
      body: json['body'] as String?,
      image: switch (json['image']) {
        final Map<String, dynamic> i => ChatImage.fromJson(i),
        _ => null,
      },
      lat: (location?['lat'] as num?)?.toDouble(),
      lng: (location?['lng'] as num?)?.toDouble(),
      listing: switch (json['listing']) {
        final Map<String, dynamic> l => ChatListing.fromJson(l),
        _ => null,
      },
      systemEvent: json['systemEvent'] as String?,
      createdAt: DateTime.parse(json['createdAt'] as String),
    );
  }

  final String id;
  final String conversationId;
  final String clientMessageId;

  /// Null for a system message.
  final String? senderMemberId;
  final MessageKind kind;
  final String? body;
  final ChatImage? image;
  final double? lat;
  final double? lng;
  final ChatListing? listing;

  /// i18n key of a system message (conversation_locked).
  final String? systemEvent;
  final DateTime createdAt;
}

/// How far one of my messages got (the ticks).
enum DeliveryState { pending, failed, sent, delivered, read }

/// sent / delivered / read from the other side's watermarks: message ids are
/// uuid v7, so their text order is their time order (ADR 058).
DeliveryState deliveryStateOf(String messageId, Conversation conversation) {
  bool reached(String? upTo) => upTo != null && messageId.compareTo(upTo) <= 0;
  if (reached(conversation.othersReadUpTo)) return DeliveryState.read;
  if (reached(conversation.othersDeliveredUpTo)) return DeliveryState.delivered;
  return DeliveryState.sent;
}

class QuickReply {
  const QuickReply({required this.id, required this.body});

  factory QuickReply.fromJson(Map<String, dynamic> json) =>
      QuickReply(id: json['id'] as String, body: json['body'] as String);

  final String id;
  final String body;
}

/// What a message says before it is sent: the API's `content`.
sealed class MessageDraft {
  const MessageDraft();

  Map<String, dynamic> toJson();

  static MessageDraft fromJson(Map<String, dynamic> json) =>
      switch (json['kind']) {
        'image' => ImageDraft(json['mediaId'] as String?),
        'location' => LocationDraft(
          (json['lat'] as num).toDouble(),
          (json['lng'] as num).toDouble(),
        ),
        'listing_card' => ListingDraft(json['postId'] as String),
        _ => TextDraft(json['body'] as String),
      };
}

class TextDraft extends MessageDraft {
  const TextDraft(this.body);
  final String body;

  @override
  Map<String, dynamic> toJson() => {'kind': 'text', 'body': body};
}

/// [mediaId] is null until the photo is uploaded (the outbox does it first).
class ImageDraft extends MessageDraft {
  const ImageDraft(this.mediaId);
  final String? mediaId;

  @override
  Map<String, dynamic> toJson() => {'kind': 'image', 'mediaId': mediaId};
}

class LocationDraft extends MessageDraft {
  const LocationDraft(this.lat, this.lng);
  final double lat;
  final double lng;

  @override
  Map<String, dynamic> toJson() => {'kind': 'location', 'lat': lat, 'lng': lng};
}

class ListingDraft extends MessageDraft {
  const ListingDraft(this.postId);
  final String postId;

  @override
  Map<String, dynamic> toJson() => {'kind': 'listing_card', 'postId': postId};
}

/// The other side is typing (ephemeral: never stored).
class TypingSignal {
  const TypingSignal({
    required this.conversationId,
    required this.memberId,
    required this.isTyping,
    required this.expiresIn,
  });

  final String conversationId;
  final String memberId;
  final bool isTyping;
  final Duration expiresIn;
}

/// The other side's delivered/read watermark moved.
class ReceiptSignal {
  const ReceiptSignal({
    required this.conversationId,
    required this.memberId,
    this.deliveredUpTo,
    this.readUpTo,
  });

  final String conversationId;
  final String memberId;
  final String? deliveredUpTo;
  final String? readUpTo;
}
