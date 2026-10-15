/// Reviews as the API sends them (apps/api/src/reviews/dto/reviews.dto.ts,
/// ADR 061).
library;

/// The seller score as a badge — the number itself is never shown.
enum SellerTier { top, trusted, good, newStore, none }

SellerTier sellerTierOf(Object? code) => switch (code) {
  'top' => SellerTier.top,
  'trusted' => SellerTier.trusted,
  'good' => SellerTier.good,
  'none' => SellerTier.none,
  _ => SellerTier.newStore,
};

class ReviewPhoto {
  const ReviewPhoto({
    required this.id,
    this.thumbhash,
    this.thumbUrl,
    this.cardUrl,
    this.fullUrl,
  });

  factory ReviewPhoto.fromJson(Map<String, dynamic> json) => ReviewPhoto(
    id: json['id'] as String,
    thumbhash: json['thumbhash'] as String?,
    thumbUrl: json['thumbUrl'] as String?,
    cardUrl: json['cardUrl'] as String?,
    fullUrl: json['fullUrl'] as String?,
  );

  final String id;
  final String? thumbhash;
  final String? thumbUrl;
  final String? cardUrl;
  final String? fullUrl;
}

List<ReviewPhoto> _photos(Object? list) => [
  for (final p in list as List? ?? const [])
    ReviewPhoto.fromJson(p as Map<String, dynamic>),
];

class ReviewResponse {
  const ReviewResponse({
    required this.text,
    required this.createdAt,
    this.editedAt,
  });

  final String text;
  final DateTime createdAt;
  final DateTime? editedAt;
}

class StoreReview {
  const StoreReview({
    required this.id,
    required this.rating,
    required this.text,
    required this.authorName,
    required this.authorRemoved,
    required this.createdAt,
    required this.photos,
    this.editedAt,
    this.response,
  });

  factory StoreReview.fromJson(Map<String, dynamic> json) {
    final response = json['response'] as Map<String, dynamic>?;
    return StoreReview(
      id: json['id'] as String,
      rating: (json['rating'] as num).toInt(),
      text: json['text'] as String?,
      authorName: json['authorName'] as String?,
      authorRemoved: json['authorRemoved'] as bool? ?? false,
      createdAt: DateTime.parse(json['createdAt'] as String),
      editedAt: switch (json['editedAt']) {
        final String s => DateTime.parse(s),
        _ => null,
      },
      photos: _photos(json['photos']),
      response: response == null
          ? null
          : ReviewResponse(
              text: response['text'] as String,
              createdAt: DateTime.parse(response['createdAt'] as String),
              editedAt: switch (response['editedAt']) {
                final String s => DateTime.parse(s),
                _ => null,
              },
            ),
    );
  }

  final String id;
  final int rating;
  final String? text;

  /// Null when the author has no name, or their account was scrubbed ([authorRemoved]).
  final String? authorName;
  final bool authorRemoved;
  final DateTime createdAt;
  final DateTime? editedAt;
  final List<ReviewPhoto> photos;
  final ReviewResponse? response;
}

class ReviewSummary {
  const ReviewSummary({
    required this.average,
    required this.count,
    required this.histogram,
    required this.tier,
  });

  factory ReviewSummary.fromJson(Map<String, dynamic> json) {
    final h = json['histogram'] as Map<String, dynamic>? ?? const {};
    return ReviewSummary(
      average: (json['average'] as num?)?.toDouble(),
      count: (json['count'] as num?)?.toInt() ?? 0,
      histogram: {
        for (var star = 1; star <= 5; star++)
          star: (h['$star'] as num?)?.toInt() ?? 0,
      },
      tier: sellerTierOf(json['tier']),
    );
  }

  static const empty = ReviewSummary(
    average: null,
    count: 0,
    histogram: {1: 0, 2: 0, 3: 0, 4: 0, 5: 0},
    tier: SellerTier.newStore,
  );

  final double? average;
  final int count;

  /// Reviews per star, 1–5.
  final Map<int, int> histogram;
  final SellerTier tier;
}

class ReviewPage {
  const ReviewPage({
    required this.summary,
    required this.items,
    required this.nextBefore,
  });

  factory ReviewPage.fromJson(Map<String, dynamic> json) => ReviewPage(
    summary: ReviewSummary.fromJson(json['summary'] as Map<String, dynamic>),
    items: [
      for (final r in json['items'] as List? ?? const [])
        StoreReview.fromJson(r as Map<String, dynamic>),
    ],
    nextBefore: json['nextBefore'] as String?,
  );

  final ReviewSummary summary;
  final List<StoreReview> items;
  final String? nextBefore;
}

enum ReviewStatus { pending, published, hidden, removed }

class MyReview {
  const MyReview({
    required this.id,
    required this.rating,
    required this.text,
    required this.status,
    required this.createdAt,
    required this.editableUntil,
    required this.photos,
    this.editedAt,
  });

  factory MyReview.fromJson(Map<String, dynamic> json) => MyReview(
    id: json['id'] as String,
    rating: (json['rating'] as num).toInt(),
    text: json['text'] as String?,
    status: switch (json['status']) {
      'pending' => ReviewStatus.pending,
      'hidden' => ReviewStatus.hidden,
      'removed' => ReviewStatus.removed,
      _ => ReviewStatus.published,
    },
    createdAt: DateTime.parse(json['createdAt'] as String),
    editedAt: switch (json['editedAt']) {
      final String s => DateTime.parse(s),
      _ => null,
    },
    editableUntil: DateTime.parse(json['editableUntil'] as String),
    photos: _photos(json['photos']),
  );

  final String id;
  final int rating;
  final String? text;
  final ReviewStatus status;
  final DateTime createdAt;
  final DateTime? editedAt;
  final DateTime editableUntil;
  final List<ReviewPhoto> photos;

  bool editableAt(DateTime now) =>
      now.isBefore(editableUntil) &&
      status != ReviewStatus.hidden &&
      status != ReviewStatus.removed;
}

/// review_eligibility (0057): may the user review this store, and why not.
enum EligibilityStatus {
  eligible,
  alreadyReviewed,
  noContact,
  tooSoon,
  expired,
  ownStore,
  storeUnavailable,
  signedOut,
}

EligibilityStatus eligibilityStatusOf(Object? code) => switch (code) {
  'eligible' => EligibilityStatus.eligible,
  'already_reviewed' => EligibilityStatus.alreadyReviewed,
  'too_soon' => EligibilityStatus.tooSoon,
  'expired' => EligibilityStatus.expired,
  'own_store' => EligibilityStatus.ownStore,
  'store_unavailable' => EligibilityStatus.storeUnavailable,
  'signed_out' => EligibilityStatus.signedOut,
  _ => EligibilityStatus.noContact,
};

class ReviewEligibility {
  const ReviewEligibility({
    required this.status,
    this.eligibleAt,
    this.expiresAt,
    this.myReview,
  });

  factory ReviewEligibility.fromJson(Map<String, dynamic> json) =>
      ReviewEligibility(
        status: eligibilityStatusOf(json['status']),
        eligibleAt: switch (json['eligibleAt']) {
          final String s => DateTime.parse(s),
          _ => null,
        },
        expiresAt: switch (json['expiresAt']) {
          final String s => DateTime.parse(s),
          _ => null,
        },
        myReview: switch (json['myReview']) {
          final Map<String, dynamic> m => MyReview.fromJson(m),
          _ => null,
        },
      );

  final EligibilityStatus status;

  /// tooSoon: when it opens.
  final DateTime? eligibleAt;

  /// eligible: when the window closes.
  final DateTime? expiresAt;
  final MyReview? myReview;
}

class WriteResult {
  const WriteResult({required this.review, required this.needsReview});

  factory WriteResult.fromJson(Map<String, dynamic> json) => WriteResult(
    review: MyReview.fromJson(json['review'] as Map<String, dynamic>),
    needsReview: json['needsReview'] as bool? ?? false,
  );

  final MyReview review;

  /// The integrity checks held it for a moderator.
  final bool needsReview;
}

/// report_reasons that fit a review.
const reviewReportReasons = ['fake_review', 'harassment', 'spam', 'other'];
