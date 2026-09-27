import 'package:json_annotation/json_annotation.dart';

import '../feed/feed.dart';
import '../tenants/lat_lng.dart';

part 'post_detail.g.dart';

/// `GET /posts/:id/detail` (apps/api/src/engagement/dto/engagement.dto.ts,
/// ADR 036). Never carries the seller's number: that comes only from
/// `POST /posts/:id/contact` ([ContactReveal]).
@JsonSerializable()
class PostDetail {
  const PostDetail({
    required this.id,
    required this.tenantId,
    required this.status,
    required this.isSold,
    required this.title,
    required this.description,
    required this.price,
    required this.priceType,
    required this.currency,
    required this.category,
    required this.fieldSchemaVersion,
    required this.fields,
    required this.media,
    required this.location,
    required this.area,
    required this.distanceMeters,
    required this.seller,
    required this.contact,
    required this.share,
    required this.similar,
    required this.isMine,
    required this.isSaved,
    required this.publishedAt,
    required this.expiresAt,
    required this.soldAt,
    required this.createdAt,
    required this.updatedAt,
    this.stats,
  });

  factory PostDetail.fromJson(Map<String, dynamic> json) =>
      _$PostDetailFromJson(json);

  final String id;
  final String tenantId;
  final String status;
  final bool isSold;
  final String title;
  final String? description;
  final String? price;

  /// fixed | negotiable | free | on_request | per_month
  final String? priceType;
  final String currency;
  final DetailCategory category;
  final int? fieldSchemaVersion;

  /// Labelled from the schema version the post was written against.
  final List<DetailField> fields;
  final List<DetailMedia> media;
  final LatLng? location;
  final OptionalName? area;
  final double? distanceMeters;
  final SellerCard seller;
  final ContactOptions contact;
  final ShareLink? share;
  final List<FeedPostCard> similar;
  final bool isMine;
  final bool isSaved;
  final DateTime? publishedAt;
  final DateTime? expiresAt;
  final DateTime? soldAt;
  final DateTime createdAt;
  final DateTime updatedAt;

  /// Owner and staff only.
  final PostStats? stats;

  PostDetail copyWith({bool? isSaved}) => PostDetail(
    id: id,
    tenantId: tenantId,
    status: status,
    isSold: isSold,
    title: title,
    description: description,
    price: price,
    priceType: priceType,
    currency: currency,
    category: category,
    fieldSchemaVersion: fieldSchemaVersion,
    fields: fields,
    media: media,
    location: location,
    area: area,
    distanceMeters: distanceMeters,
    seller: seller,
    contact: contact,
    share: share,
    similar: similar,
    isMine: isMine,
    isSaved: isSaved ?? this.isSaved,
    publishedAt: publishedAt,
    expiresAt: expiresAt,
    soldAt: soldAt,
    createdAt: createdAt,
    updatedAt: updatedAt,
    stats: stats,
  );

  Map<String, dynamic> toJson() => _$PostDetailToJson(this);
}

@JsonSerializable()
class DetailCategory {
  const DetailCategory({
    required this.id,
    required this.slug,
    required this.name,
  });

  factory DetailCategory.fromJson(Map<String, dynamic> json) =>
      _$DetailCategoryFromJson(json);

  final String id;
  final String slug;
  final OptionalName name;

  Map<String, dynamic> toJson() => _$DetailCategoryToJson(this);
}

@JsonSerializable()
class DetailField {
  const DetailField({
    required this.key,
    required this.type,
    required this.label,
    required this.value,
    this.optionLabels,
  });

  factory DetailField.fromJson(Map<String, dynamic> json) =>
      _$DetailFieldFromJson(json);

  final String key;

  /// The field type: text | number | money | select | multiselect | bool | date | phone ...
  final String type;
  final OptionalName label;
  final Object? value;

  /// select/multiselect: the chosen options' labels, in value order.
  final List<OptionalName>? optionLabels;

  Map<String, dynamic> toJson() => _$DetailFieldToJson(this);
}

@JsonSerializable()
class DetailMedia {
  const DetailMedia({
    required this.id,
    required this.thumbhash,
    required this.variants,
  });

  factory DetailMedia.fromJson(Map<String, dynamic> json) =>
      _$DetailMediaFromJson(json);

  final String id;
  final String? thumbhash;

  /// Null while a photo is still being processed.
  final MediaVariants? variants;

  Map<String, dynamic> toJson() => _$DetailMediaToJson(this);
}

@JsonSerializable()
class MediaVariants {
  const MediaVariants({
    required this.thumb,
    required this.card,
    required this.full,
  });

  factory MediaVariants.fromJson(Map<String, dynamic> json) =>
      _$MediaVariantsFromJson(json);

  final MediaVariant thumb;
  final MediaVariant card;
  final MediaVariant full;

  Map<String, dynamic> toJson() => _$MediaVariantsToJson(this);
}

@JsonSerializable()
class MediaVariant {
  const MediaVariant({
    required this.url,
    required this.width,
    required this.height,
  });

  factory MediaVariant.fromJson(Map<String, dynamic> json) =>
      _$MediaVariantFromJson(json);

  final String url;
  final int width;
  final int height;

  Map<String, dynamic> toJson() => _$MediaVariantToJson(this);
}

@JsonSerializable()
class SellerCard {
  const SellerCard({
    required this.name,
    required this.memberSince,
    required this.badges,
    required this.store,
    required this.responseHint,
  });

  factory SellerCard.fromJson(Map<String, dynamic> json) =>
      _$SellerCardFromJson(json);

  final String? name;
  final DateTime? memberSince;

  /// trusted | phone_verified | verified_store
  final List<String> badges;
  final StoreRef? store;
  final ResponseHint? responseHint;

  Map<String, dynamic> toJson() => _$SellerCardToJson(this);
}

@JsonSerializable()
class StoreRef {
  const StoreRef({
    required this.id,
    required this.slug,
    required this.name,
    required this.verified,
  });

  factory StoreRef.fromJson(Map<String, dynamic> json) =>
      _$StoreRefFromJson(json);

  final String id;
  final String slug;
  final OptionalName name;
  final bool verified;

  Map<String, dynamic> toJson() => _$StoreRefToJson(this);
}

@JsonSerializable()
class ResponseHint {
  const ResponseHint({required this.ratePercent, required this.medianMinutes});

  factory ResponseHint.fromJson(Map<String, dynamic> json) =>
      _$ResponseHintFromJson(json);

  final double? ratePercent;
  final int? medianMinutes;

  Map<String, dynamic> toJson() => _$ResponseHintToJson(this);
}

/// How a buyer may reach the seller — never the number itself.
@JsonSerializable()
class ContactOptions {
  const ContactOptions({
    required this.name,
    required this.channels,
    required this.allowChat,
    required this.loginRequired,
  });

  factory ContactOptions.fromJson(Map<String, dynamic> json) =>
      _$ContactOptionsFromJson(json);

  final String? name;

  /// call | whatsapp | sms
  final List<String> channels;
  final bool allowChat;

  /// The post's area asks guests to sign in before a reveal.
  final bool loginRequired;

  Map<String, dynamic> toJson() => _$ContactOptionsToJson(this);
}

@JsonSerializable()
class ShareLink {
  const ShareLink({required this.code, required this.url});

  factory ShareLink.fromJson(Map<String, dynamic> json) =>
      _$ShareLinkFromJson(json);

  final String code;
  final String url;

  Map<String, dynamic> toJson() => _$ShareLinkToJson(this);
}

@JsonSerializable()
class PostStats {
  const PostStats({
    required this.views,
    required this.contacts,
    required this.saves,
  });

  factory PostStats.fromJson(Map<String, dynamic> json) =>
      _$PostStatsFromJson(json);

  final int views;
  final ContactCounts contacts;
  final int saves;

  Map<String, dynamic> toJson() => _$PostStatsToJson(this);
}

@JsonSerializable()
class ContactCounts {
  const ContactCounts({
    required this.call,
    required this.whatsapp,
    required this.sms,
    required this.total,
  });

  factory ContactCounts.fromJson(Map<String, dynamic> json) =>
      _$ContactCountsFromJson(json);

  final int call;
  final int whatsapp;
  final int sms;
  final int total;

  Map<String, dynamic> toJson() => _$ContactCountsToJson(this);
}

/// `POST /posts/:id/contact`: the number, and what to open.
@JsonSerializable()
class ContactReveal {
  const ContactReveal({
    required this.channel,
    required this.name,
    required this.phone,
    required this.href,
    required this.message,
  });

  factory ContactReveal.fromJson(Map<String, dynamic> json) =>
      _$ContactRevealFromJson(json);

  final String channel;
  final String? name;

  /// E.164, e.g. +8801712345678.
  final String phone;

  /// tel:, sms: (with the message) or a wa.me link with the message.
  final String href;

  /// The prefilled Bengali message for SMS and WhatsApp; null for a call.
  final String? message;

  Map<String, dynamic> toJson() => _$ContactRevealToJson(this);
}

/// `POST /saved/:itemType/:itemId`.
@JsonSerializable()
class SaveResult {
  const SaveResult({
    required this.itemType,
    required this.itemId,
    required this.savedAt,
    required this.created,
  });

  factory SaveResult.fromJson(Map<String, dynamic> json) =>
      _$SaveResultFromJson(json);

  final String itemType;
  final String itemId;
  final DateTime savedAt;
  final bool created;

  Map<String, dynamic> toJson() => _$SaveResultToJson(this);
}
