import 'package:json_annotation/json_annotation.dart';

import '../tenants/lat_lng.dart';

part 'post_view.g.dart';

/// Mirrors `PostView` (apps/api/src/posts/dto/posts.dto.ts) — the body of
/// `GET /posts/:id`, every post action, and each item of `GET /posts/me`.
@JsonSerializable()
class PostView {
  const PostView({
    required this.id,
    required this.tenantId,
    required this.status,
    required this.categoryId,
    required this.fieldSchemaId,
    required this.title,
    required this.description,
    required this.fields,
    required this.price,
    required this.location,
    required this.outsideBoundary,
    required this.media,
    required this.showPhone,
    required this.allowChat,
    required this.showWhatsapp,
    required this.contact,
    required this.isSold,
    required this.soldPrice,
    required this.publishedAt,
    required this.expiresAt,
    required this.createdAt,
    required this.updatedAt,
    required this.isMine,
    this.hiddenByOwner,
    this.moderationReason,
    this.moderationNote,
  });

  factory PostView.fromJson(Map<String, dynamic> json) =>
      _$PostViewFromJson(json);

  final String id;
  final String tenantId;

  /// draft | pending | live | rejected | sold | expired | removed
  final String status;
  final String categoryId;
  final String fieldSchemaId;
  final String title;
  final String? description;
  final Map<String, dynamic> fields;

  /// Money as a string with two decimals (`"15000.00"`), never a number.
  final String? price;
  final LatLng? location;
  final bool outsideBoundary;
  final List<PostMedia> media;
  final bool showPhone;
  final bool allowChat;
  final bool showWhatsapp;
  final PostContact contact;
  final bool isSold;
  final String? soldPrice;
  final DateTime? publishedAt;
  final DateTime? expiresAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  final bool isMine;

  /// Owner and staff only.
  final bool? hiddenByOwner;
  final String? moderationReason;
  final String? moderationNote;

  Map<String, dynamic> toJson() => _$PostViewToJson(this);
}

@JsonSerializable()
class PostMedia {
  const PostMedia({
    required this.id,
    required this.thumbhash,
    required this.thumbUrl,
    required this.cardUrl,
    required this.fullUrl,
  });

  factory PostMedia.fromJson(Map<String, dynamic> json) =>
      _$PostMediaFromJson(json);

  final String id;
  final String? thumbhash;
  final String? thumbUrl;
  final String? cardUrl;
  final String? fullUrl;

  Map<String, dynamic> toJson() => _$PostMediaToJson(this);
}

/// What a buyer sees: the phone only when the seller shows it.
@JsonSerializable()
class PostContact {
  const PostContact({
    required this.name,
    required this.phone,
    required this.whatsapp,
  });

  factory PostContact.fromJson(Map<String, dynamic> json) =>
      _$PostContactFromJson(json);

  final String? name;
  final String? phone;
  final bool whatsapp;

  Map<String, dynamic> toJson() => _$PostContactToJson(this);
}

/// `GET /posts/me`.
@JsonSerializable()
class MyPostsPage {
  const MyPostsPage({required this.items, required this.nextCursor});

  factory MyPostsPage.fromJson(Map<String, dynamic> json) =>
      _$MyPostsPageFromJson(json);

  final List<PostView> items;
  final String? nextCursor;

  Map<String, dynamic> toJson() => _$MyPostsPageToJson(this);
}

/// `GET /posts/me/counts` — each status among visible posts, plus every hidden one.
@JsonSerializable()
class MyPostCounts {
  const MyPostCounts({
    required this.draft,
    required this.pending,
    required this.live,
    required this.rejected,
    required this.sold,
    required this.expired,
    required this.removed,
    required this.hidden,
  });

  factory MyPostCounts.fromJson(Map<String, dynamic> json) =>
      _$MyPostCountsFromJson(json);

  final int draft;
  final int pending;
  final int live;
  final int rejected;
  final int sold;
  final int expired;
  final int removed;
  final int hidden;

  Map<String, dynamic> toJson() => _$MyPostCountsToJson(this);
}

/// `GET /posts/ownership` — which area a post at a point is listed in.
@JsonSerializable()
class PostOwnership {
  const PostOwnership({
    required this.tenantId,
    required this.resolution,
    required this.outsideBoundary,
    required this.needsReview,
  });

  factory PostOwnership.fromJson(Map<String, dynamic> json) =>
      _$PostOwnershipFromJson(json);

  final String tenantId;

  /// inside_boundary | within_buffer | beyond_buffer_fallback | no_location
  final String resolution;
  final bool outsideBoundary;

  /// A beyond-buffer post always waits for a moderator.
  final bool needsReview;

  Map<String, dynamic> toJson() => _$PostOwnershipToJson(this);
}
