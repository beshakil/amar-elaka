import 'dart:io';

import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/reviews/data/review_models.dart';
import 'package:amar_elaka_app/features/reviews/data/reviews_api.dart';

/// Long, conjunct-heavy Bengali and mixed text: where wrapping breaks first.
const longBengaliReview =
    'দোকানদার খুব ভদ্র ও আন্তরিক। মোবাইলটা একদম নতুনের মতো ছিল, বক্স আর চার্জারসহ পেয়েছি। '
    'দাম নিয়ে একটু দরদাম করতে হয়েছে, তবে শেষ পর্যন্ত ন্যায্য দামেই কিনেছি। '
    'ডেলিভারি সময়মতো হয়েছে — সবাইকে এই দোকানের কথা বলব।';
const mixedReview =
    'iPhone 13 Pro ভালো condition-এ ছিল, battery health 89%. Recommended!';

Map<String, dynamic> reviewJson({
  String id = 'r1',
  int rating = 5,
  String? text = longBengaliReview,
  String? authorName = 'করিম উদ্দিন',
  bool authorRemoved = false,
  String? reply,
}) => {
  'id': id,
  'rating': rating,
  'text': text,
  'authorName': authorName,
  'authorRemoved': authorRemoved,
  'verifiedContact': true,
  'createdAt': '2026-10-01T10:00:00.000Z',
  'editedAt': null,
  'photos': <Object>[],
  'response': reply == null
      ? null
      : {
          'text': reply,
          'createdAt': '2026-10-02T10:00:00.000Z',
          'editedAt': null,
        },
};

ReviewPage reviewPage({
  List<Map<String, dynamic>>? items,
  String tier = 'trusted',
}) {
  final list =
      items ??
      [
        reviewJson(reply: 'ধন্যবাদ! আবার আসবেন।'),
        reviewJson(
          id: 'r2',
          rating: 4,
          text: mixedReview,
          authorName: null,
          authorRemoved: true,
        ),
      ];
  return ReviewPage.fromJson({
    'summary': {
      'average': 4.5,
      'count': list.length,
      'histogram': {'1': 0, '2': 0, '3': 0, '4': 1, '5': 1},
      'tier': tier,
    },
    'items': list,
    'nextBefore': null,
  });
}

Map<String, dynamic> myReviewJson({
  String status = 'published',
  int rating = 4,
}) => {
  'id': 'mine',
  'rating': rating,
  'text': 'ভালো দোকান',
  'status': status,
  'createdAt': DateTime.now().toUtc().toIso8601String(),
  'editedAt': null,
  'editableUntil': DateTime.now()
      .toUtc()
      .add(const Duration(days: 20))
      .toIso8601String(),
  'photos': <Object>[],
};

/// The reviews API in memory: what was sent, and what to answer.
class FakeReviewsApi implements ReviewsApi {
  FakeReviewsApi({
    ReviewPage? page,
    ReviewEligibility? eligibility,
    this.needsReview = false,
  }) : page_ = page ?? reviewPage(),
       eligibility_ =
           eligibility ??
           const ReviewEligibility(status: EligibilityStatus.eligible);

  ReviewPage page_;
  ReviewEligibility eligibility_;
  bool needsReview;
  final submitted = <({int rating, String? text, List<String> photoIds})>[];
  final edited = <({int rating, String? text})>[];
  final replies = <(String reviewId, String text)>[];
  final reports = <(String reviewId, String reason)>[];
  ApiException? failNextWrite;

  @override
  Future<ReviewPage> page(String storeId, {String? before}) async => page_;

  @override
  Future<ReviewEligibility> eligibility(String storeId) async => eligibility_;

  WriteResult _result(int rating, String? text) => WriteResult.fromJson({
    'review': {
      ...myReviewJson(
        status: needsReview ? 'pending' : 'published',
        rating: rating,
      ),
      'text': text,
    },
    'needsReview': needsReview,
  });

  @override
  Future<WriteResult> submit(
    String storeId, {
    required int rating,
    String? text,
    List<String> photoIds = const [],
  }) async {
    if (failNextWrite case final e?) {
      failNextWrite = null;
      throw e;
    }
    submitted.add((rating: rating, text: text, photoIds: photoIds));
    return _result(rating, text);
  }

  @override
  Future<WriteResult> edit(
    String storeId, {
    required int rating,
    String? text,
    List<String> photoIds = const [],
  }) async {
    edited.add((rating: rating, text: text));
    return _result(rating, text);
  }

  @override
  Future<bool> respond(String storeId, String reviewId, String text) async {
    replies.add((reviewId, text));
    return true;
  }

  @override
  Future<void> report(
    String storeId,
    String reviewId,
    String reasonCode,
    String? details,
  ) async {
    reports.add((reviewId, reasonCode));
  }

  @override
  Future<String> uploadImage(String storeId, File file) async => 'media-1';
}

ApiException reviewApiError(int status, String code, {Object? details}) =>
    ApiException(
      ApiErrorBody(
        statusCode: status,
        error: code,
        message: code,
        details: details,
      ),
    );
