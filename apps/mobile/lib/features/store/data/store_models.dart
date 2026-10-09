import 'package:amar_elaka_api/amar_elaka_api.dart';

/// The store screens' data (ADR 054/057), read from the API's JSON by hand
/// like the other feature APIs. Names come in Bengali and, sometimes, English.

class StoreName {
  const StoreName({required this.bn, required this.en});

  factory StoreName.fromJson(Map<String, dynamic>? json) =>
      StoreName(bn: json?['bn'] as String?, en: json?['en'] as String?);

  final String? bn;
  final String? en;

  String of(String locale, {String fallback = ''}) =>
      (locale == 'en' ? en ?? bn : bn ?? en) ?? fallback;
}

class StoreImage {
  const StoreImage({required this.url, required this.thumbhash});

  static StoreImage? fromJson(Map<String, dynamic>? json) => json == null
      ? null
      : StoreImage(
          url: json['url'] as String,
          thumbhash: json['thumbhash'] as String?,
        );

  final String url;
  final String? thumbhash;
}

/// One opening range on a weekday (ISO 1 = Monday … 7 = Sunday). A range
/// that closes before it opens runs past midnight.
class WeeklyRange {
  const WeeklyRange({
    required this.day,
    required this.opens,
    required this.closes,
  });

  factory WeeklyRange.fromJson(Map<String, dynamic> json) => WeeklyRange(
    day: (json['day'] as num).toInt(),
    opens: json['opens'] as String,
    closes: json['closes'] as String,
  );

  final int day;

  /// HH:MM, 24-hour.
  final String opens;
  final String closes;

  Map<String, dynamic> toJson() => {
    'day': day,
    'opens': opens,
    'closes': closes,
  };

  @override
  bool operator ==(Object other) =>
      other is WeeklyRange &&
      other.day == day &&
      other.opens == opens &&
      other.closes == closes;

  @override
  int get hashCode => Object.hash(day, opens, closes);
}

/// A holiday, or a day with different hours.
class SpecialDay {
  const SpecialDay({
    required this.date,
    required this.closed,
    this.ranges = const [],
    this.note,
  });

  factory SpecialDay.fromJson(Map<String, dynamic> json) => SpecialDay(
    date: json['date'] as String,
    closed: json['closed'] as bool,
    ranges: [
      for (final r in json['ranges'] as List? ?? const [])
        (
          opens: (r as Map<String, dynamic>)['opens'] as String,
          closes: r['closes'] as String,
        ),
    ],
    note: json['note'] as String?,
  );

  /// YYYY-MM-DD.
  final String date;
  final bool closed;
  final List<({String opens, String closes})> ranges;
  final String? note;

  Map<String, dynamic> toJson() => {
    'date': date,
    'closed': closed,
    if (!closed)
      'ranges': [
        for (final r in ranges) {'opens': r.opens, 'closes': r.closes},
      ],
    if (note case final note? when note.isNotEmpty) 'note': note,
  };
}

class StoreHours {
  const StoreHours({
    required this.weekly,
    required this.specialDays,
    required this.closedUntil,
    required this.openState,
  });

  factory StoreHours.fromJson(Map<String, dynamic>? json) => StoreHours(
    weekly: [
      for (final r in json?['weekly'] as List? ?? const [])
        WeeklyRange.fromJson(r as Map<String, dynamic>),
    ],
    specialDays: [
      for (final d in json?['specialDays'] as List? ?? const [])
        SpecialDay.fromJson(d as Map<String, dynamic>),
    ],
    closedUntil: json?['closedUntil'] as String?,
    openState:
        (json?['openState'] as Map<String, dynamic>?)?['state'] as String?,
  );

  final List<WeeklyRange> weekly;
  final List<SpecialDay> specialDays;

  /// Set while "closed today" is on.
  final String? closedUntil;

  /// open | closes_soon | opens_soon | closed | unknown; null = no hours.
  final String? openState;
}

class CatalogCategoryTab {
  const CatalogCategoryTab({
    required this.slug,
    required this.name,
    required this.count,
  });

  final String slug;
  final StoreName name;
  final int count;
}

/// GET /stores/:slug — a store's public page. Never its numbers: calling
/// goes through POST /stores/:id/contact, which records the lead.
class StorePageData {
  const StorePageData({
    required this.id,
    required this.slug,
    required this.url,
    required this.name,
    required this.description,
    required this.addressText,
    required this.area,
    required this.pin,
    required this.logo,
    required this.cover,
    required this.isVerified,
    required this.isFollowing,
    required this.followerCount,
    required this.livePosts,
    required this.contactChannels,
    required this.hours,
    required this.categories,
    required this.posts,
    required this.nextCursor,
  });

  factory StorePageData.fromJson(Map<String, dynamic> json) {
    final pin =
        json['mapPin'] as Map<String, dynamic>? ??
        json['location'] as Map<String, dynamic>?;
    final stats = json['stats'] as Map<String, dynamic>?;
    return StorePageData(
      id: json['id'] as String,
      slug: json['slug'] as String,
      url: json['url'] as String,
      name: StoreName.fromJson(json['name'] as Map<String, dynamic>?),
      description: json['description'] as String?,
      addressText: json['addressText'] as String?,
      area: json['area'] == null
          ? null
          : StoreName.fromJson(json['area'] as Map<String, dynamic>),
      pin: pin == null
          ? null
          : (
              lat: (pin['lat'] as num).toDouble(),
              lng: (pin['lng'] as num).toDouble(),
            ),
      logo: StoreImage.fromJson(json['logo'] as Map<String, dynamic>?),
      cover: StoreImage.fromJson(json['cover'] as Map<String, dynamic>?),
      isVerified: json['isVerified'] as bool? ?? false,
      isFollowing: json['isFollowing'] as bool? ?? false,
      followerCount: (json['followerCount'] as num?)?.toInt() ?? 0,
      livePosts: (stats?['livePosts'] as num?)?.toInt() ?? 0,
      contactChannels: [
        for (final c in json['contactChannels'] as List? ?? const [])
          c as String,
      ],
      hours: StoreHours.fromJson(json['hours'] as Map<String, dynamic>?),
      categories: [
        for (final c in json['catalogCategories'] as List? ?? const [])
          CatalogCategoryTab(
            slug: (c as Map<String, dynamic>)['slug'] as String,
            name: StoreName.fromJson(c['name'] as Map<String, dynamic>?),
            count: (c['count'] as num).toInt(),
          ),
      ],
      posts: [
        for (final p in json['posts'] as List? ?? const [])
          FeedPostCard.fromJson(p as Map<String, dynamic>),
      ],
      nextCursor: json['nextCursor'] as String?,
    );
  }

  final String id;
  final String slug;

  /// The page on the tenant's site, for sharing.
  final String url;
  final StoreName name;
  final String? description;
  final String? addressText;
  final StoreName? area;
  final ({double lat, double lng})? pin;
  final StoreImage? logo;
  final StoreImage? cover;
  final bool isVerified;
  final bool isFollowing;
  final int followerCount;
  final int livePosts;

  /// call | whatsapp | sms — which the store takes.
  final List<String> contactChannels;
  final StoreHours hours;
  final List<CatalogCategoryTab> categories;
  final List<FeedPostCard> posts;
  final String? nextCursor;

  StorePageData copyWith({
    bool? isFollowing,
    int? followerCount,
    List<FeedPostCard>? posts,
    String? nextCursor,
    bool clearCursor = false,
  }) => StorePageData(
    id: id,
    slug: slug,
    url: url,
    name: name,
    description: description,
    addressText: addressText,
    area: area,
    pin: pin,
    logo: logo,
    cover: cover,
    isVerified: isVerified,
    isFollowing: isFollowing ?? this.isFollowing,
    followerCount: followerCount ?? this.followerCount,
    livePosts: livePosts,
    contactChannels: contactChannels,
    hours: hours,
    categories: categories,
    posts: posts ?? this.posts,
    nextCursor: clearCursor ? null : nextCursor ?? this.nextCursor,
  );
}

// ---- the seller's side ------------------------------------------------------

/// One of the stores the signed-in member owns or staffs (GET /stores/me).
class MyStoreSummary {
  const MyStoreSummary({
    required this.id,
    required this.slug,
    required this.name,
    required this.status,
    required this.role,
    required this.accepted,
  });

  factory MyStoreSummary.fromJson(Map<String, dynamic> json) => MyStoreSummary(
    id: json['id'] as String,
    slug: json['slug'] as String,
    name: StoreName.fromJson(json['name'] as Map<String, dynamic>?),
    status: json['status'] as String,
    role: json['role'] as String,
    accepted: json['accepted'] as bool,
  );

  final String id;
  final String slug;
  final StoreName name;

  /// pending_review | active | suspended | closed
  final String status;

  /// owner | manager | editor
  final String role;

  /// false: an invitation not yet accepted.
  final bool accepted;
}

class StaffMember {
  const StaffMember({
    required this.memberId,
    required this.displayName,
    required this.phoneMasked,
    required this.role,
    required this.accepted,
  });

  factory StaffMember.fromJson(Map<String, dynamic> json) => StaffMember(
    memberId: json['memberId'] as String,
    displayName: json['displayName'] as String?,
    phoneMasked: json['phoneMasked'] as String?,
    role: json['role'] as String,
    accepted: json['accepted'] as bool,
  );

  final String memberId;
  final String? displayName;

  /// e.g. 017••••5678 — never the full number.
  final String? phoneMasked;

  /// manager | editor
  final String role;
  final bool accepted;
}

/// GET /stores/:id/manage — the store as its owner and staff see it.
class ManagedStore {
  const ManagedStore({
    required this.id,
    required this.slug,
    required this.catalogUrl,
    required this.name,
    required this.description,
    required this.categoryId,
    required this.logo,
    required this.banner,
    required this.phone,
    required this.whatsapp,
    required this.addressText,
    required this.location,
    required this.status,
    required this.myRole,
    required this.staffLimit,
    required this.staff,
  });

  factory ManagedStore.fromJson(Map<String, dynamic> json) {
    final location = json['location'] as Map<String, dynamic>?;
    return ManagedStore(
      id: json['id'] as String,
      slug: json['slug'] as String,
      catalogUrl: json['catalogUrl'] as String,
      name: StoreName.fromJson(json['name'] as Map<String, dynamic>?),
      description: json['description'] as String?,
      categoryId: (json['category'] as Map<String, dynamic>?)?['id'] as String?,
      logo: StoreImage.fromJson(json['logo'] as Map<String, dynamic>?),
      banner: StoreImage.fromJson(json['banner'] as Map<String, dynamic>?),
      phone: json['phone'] as String?,
      whatsapp: json['whatsapp'] as String?,
      addressText: json['addressText'] as String?,
      location: location == null
          ? null
          : (
              lat: (location['lat'] as num).toDouble(),
              lng: (location['lng'] as num).toDouble(),
            ),
      status: json['status'] as String,
      myRole: json['myRole'] as String,
      staffLimit:
          ((json['limits'] as Map<String, dynamic>?)?['staff'] as num?)
              ?.toInt() ??
          0,
      staff: [
        for (final s in json['staff'] as List? ?? const [])
          StaffMember.fromJson(s as Map<String, dynamic>),
      ],
    );
  }

  final String id;
  final String slug;
  final String catalogUrl;
  final StoreName name;
  final String? description;
  final String? categoryId;
  final StoreImage? logo;
  final StoreImage? banner;

  /// The store's own numbers, shown to its people only.
  final String? phone;
  final String? whatsapp;
  final String? addressText;
  final ({double lat, double lng})? location;
  final String status;
  final String myRole;
  final int staffLimit;
  final List<StaffMember> staff;

  bool get canEdit => myRole == 'owner' || myRole == 'manager';
}

/// One row of GET /stores/:id/products.
class StoreProduct {
  const StoreProduct({
    required this.id,
    required this.title,
    required this.price,
    required this.status,
    required this.stockStatus,
    required this.thumbUrl,
    required this.canManage,
  });

  factory StoreProduct.fromJson(Map<String, dynamic> json) => StoreProduct(
    id: json['id'] as String,
    title: json['title'] as String,
    price: json['price'] as String?,
    status: json['status'] as String,
    stockStatus: json['stockStatus'] as String,
    thumbUrl: json['thumbUrl'] as String?,
    canManage: json['canManage'] as bool,
  );

  final String id;
  final String title;
  final String? price;
  final String status;

  /// in_stock | out_of_stock | on_order
  final String stockStatus;
  final String? thumbUrl;
  final bool canManage;

  StoreProduct withStock(String stock) => StoreProduct(
    id: id,
    title: title,
    price: price,
    status: status,
    stockStatus: stock,
    thumbUrl: thumbUrl,
    canManage: canManage,
  );
}

/// What a new store needs (POST /stores).
class NewStore {
  const NewStore({
    required this.nameBn,
    required this.categoryId,
    required this.lat,
    required this.lng,
    this.nameEn,
    this.description,
    this.addressText,
    this.phone,
    this.whatsapp,
    this.logoMediaId,
    this.bannerMediaId,
    this.confirmNotDuplicate = false,
  });

  final String nameBn;
  final String? nameEn;
  final String? description;
  final String categoryId;
  final double lat;
  final double lng;
  final String? addressText;

  /// E.164 (+8801…).
  final String? phone;
  final String? whatsapp;
  final String? logoMediaId;
  final String? bannerMediaId;
  final bool confirmNotDuplicate;

  NewStore confirmed() => NewStore(
    nameBn: nameBn,
    nameEn: nameEn,
    description: description,
    categoryId: categoryId,
    lat: lat,
    lng: lng,
    addressText: addressText,
    phone: phone,
    whatsapp: whatsapp,
    logoMediaId: logoMediaId,
    bannerMediaId: bannerMediaId,
    confirmNotDuplicate: true,
  );

  Map<String, dynamic> toJson() => {
    'nameBn': nameBn,
    'nameEn': ?nameEn,
    'description': ?description,
    'categoryId': categoryId,
    'location': {'lat': lat, 'lng': lng},
    'addressText': ?addressText,
    'phone': ?phone,
    'whatsapp': ?whatsapp,
    'logoMediaId': ?logoMediaId,
    'bannerMediaId': ?bannerMediaId,
    if (confirmNotDuplicate) 'confirmNotDuplicate': true,
  };
}
