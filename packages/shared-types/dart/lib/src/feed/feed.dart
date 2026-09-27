import 'package:json_annotation/json_annotation.dart';

part 'feed.g.dart';

/// A `{bn, en}` pair where either side may be missing (area names, store
/// names). Mirrors the API's `localized` schema.
@JsonSerializable()
class OptionalName {
  const OptionalName({this.bn, this.en});

  factory OptionalName.fromJson(Map<String, dynamic> json) =>
      _$OptionalNameFromJson(json);

  final String? bn;
  final String? en;

  /// The name in [locale], falling back to the other language.
  String? of(String locale) => locale == 'bn' ? (bn ?? en) : (en ?? bn);

  Map<String, dynamic> toJson() => _$OptionalNameToJson(this);
}

/// A card's cover: the card-size variant URL and its thumbhash placeholder.
@JsonSerializable()
class CoverImage {
  const CoverImage({required this.url, this.thumbhash});

  factory CoverImage.fromJson(Map<String, dynamic> json) =>
      _$CoverImageFromJson(json);

  final String url;
  final String? thumbhash;

  Map<String, dynamic> toJson() => _$CoverImageToJson(this);
}

/// `GET /feed` (apps/api/src/feed/dto/feed.dto.ts, ADR 035).
class FeedPage {
  const FeedPage({
    required this.items,
    required this.nextCursor,
    required this.scope,
    required this.radiusKm,
  });

  factory FeedPage.fromJson(Map<String, dynamic> json) => FeedPage(
    items: [
      for (final item in json['items'] as List<dynamic>)
        ?FeedItem.fromJson(item as Map<String, dynamic>),
    ],
    nextCursor: json['nextCursor'] as String?,
    scope: json['scope'] as String,
    radiusKm: (json['radiusKm'] as num?)?.toDouble(),
  );

  final List<FeedItem> items;

  /// Pass back as `cursor` with the same query; null at the end.
  final String? nextCursor;

  /// area | nearby | country
  final String scope;
  final double? radiusKm;
}

/// One entry of the feed: a post, a store, or an info card.
sealed class FeedItem {
  const FeedItem();

  /// Null for a kind this app version doesn't know: skipped, never a crash.
  static FeedItem? fromJson(Map<String, dynamic> json) =>
      switch (json['kind']) {
        'post' => FeedPostCard.fromJson(json),
        'store' => FeedStoreCard.fromJson(json),
        'landmark' => FeedLandmarkCard.fromJson(json),
        'bazar_prices' => FeedBazarCard.fromJson(json),
        'emergency' => FeedEmergencyCard.fromJson(json),
        _ => null,
      };
}

@JsonSerializable()
class FeedPostCard extends FeedItem {
  const FeedPostCard({
    required this.id,
    required this.tenantId,
    required this.title,
    required this.price,
    required this.cover,
    required this.distanceMeters,
    required this.area,
    required this.badges,
    required this.createdAt,
    this.isSaved = false,
    this.isSold = false,
  });

  factory FeedPostCard.fromJson(Map<String, dynamic> json) =>
      _$FeedPostCardFromJson(json);

  final String id;
  final String tenantId;
  final String title;

  /// Money as a string with two decimals, never a number.
  final String? price;
  final CoverImage? cover;
  final double? distanceMeters;
  final OptionalName? area;

  /// boosted | highlighted | verified_store | free | negotiable
  final List<String> badges;
  final DateTime createdAt;
  final bool isSaved;

  /// Not sent by the feed (it only lists live posts); set by callers that
  /// show a card for a post they know is sold.
  @JsonKey(includeFromJson: false, includeToJson: false)
  final bool isSold;

  FeedPostCard copyWith({bool? isSaved, bool? isSold}) => FeedPostCard(
    id: id,
    tenantId: tenantId,
    title: title,
    price: price,
    cover: cover,
    distanceMeters: distanceMeters,
    area: area,
    badges: badges,
    createdAt: createdAt,
    isSaved: isSaved ?? this.isSaved,
    isSold: isSold ?? this.isSold,
  );

  Map<String, dynamic> toJson() => _$FeedPostCardToJson(this);
}

@JsonSerializable()
class FeedStoreCard extends FeedItem {
  const FeedStoreCard({
    required this.id,
    required this.tenantId,
    required this.slug,
    required this.name,
    required this.cover,
    required this.distanceMeters,
    required this.isVerified,
    required this.rating,
  });

  factory FeedStoreCard.fromJson(Map<String, dynamic> json) =>
      _$FeedStoreCardFromJson(json);

  final String id;
  final String tenantId;
  final String slug;
  final OptionalName name;
  final CoverImage? cover;
  final double distanceMeters;
  final bool isVerified;
  final double? rating;

  Map<String, dynamic> toJson() => _$FeedStoreCardToJson(this);
}

@JsonSerializable()
class FeedLandmarkCard extends FeedItem {
  const FeedLandmarkCard({
    required this.id,
    required this.tenantId,
    required this.slug,
    required this.name,
    required this.distanceMeters,
  });

  factory FeedLandmarkCard.fromJson(Map<String, dynamic> json) =>
      _$FeedLandmarkCardFromJson(json);

  final String id;
  final String tenantId;
  final String slug;
  final OptionalName name;
  final double distanceMeters;

  Map<String, dynamic> toJson() => _$FeedLandmarkCardToJson(this);
}

/// Today's bazar prices (Asia/Dhaka date).
@JsonSerializable()
class FeedBazarCard extends FeedItem {
  const FeedBazarCard({required this.date, required this.items});

  factory FeedBazarCard.fromJson(Map<String, dynamic> json) =>
      _$FeedBazarCardFromJson(json);

  final String date;
  final List<BazarPrice> items;

  Map<String, dynamic> toJson() => _$FeedBazarCardToJson(this);
}

@JsonSerializable()
class BazarPrice {
  const BazarPrice({
    required this.commodity,
    required this.name,
    required this.unit,
    required this.minPrice,
    required this.maxPrice,
  });

  factory BazarPrice.fromJson(Map<String, dynamic> json) =>
      _$BazarPriceFromJson(json);

  final String commodity;
  final OptionalName name;
  final String unit;
  final String minPrice;
  final String maxPrice;

  Map<String, dynamic> toJson() => _$BazarPriceToJson(this);
}

/// The emergency shortcut: hotlines to dial.
@JsonSerializable()
class FeedEmergencyCard extends FeedItem {
  const FeedEmergencyCard({required this.hotlines});

  factory FeedEmergencyCard.fromJson(Map<String, dynamic> json) =>
      _$FeedEmergencyCardFromJson(json);

  final List<Hotline> hotlines;

  Map<String, dynamic> toJson() => _$FeedEmergencyCardToJson(this);
}

@JsonSerializable()
class Hotline {
  const Hotline({
    required this.serviceType,
    required this.name,
    required this.dial,
  });

  factory Hotline.fromJson(Map<String, dynamic> json) =>
      _$HotlineFromJson(json);

  final String serviceType;
  final OptionalName name;
  final String dial;

  Map<String, dynamic> toJson() => _$HotlineToJson(this);
}
