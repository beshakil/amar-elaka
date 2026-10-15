import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import 'review_models.dart';

/// A store's reviews over REST (apps/api/src/reviews/reviews.controller.ts,
/// ADR 061). Every call is about one store; the API runs it in the store's
/// own area, whichever area the user lives in.
abstract interface class ReviewsApi {
  Future<ReviewPage> page(String storeId, {String? before});
  Future<ReviewEligibility> eligibility(String storeId);
  Future<WriteResult> submit(
    String storeId, {
    required int rating,
    String? text,
    List<String> photoIds,
  });
  Future<WriteResult> edit(
    String storeId, {
    required int rating,
    String? text,
    List<String> photoIds,
  });

  /// The store's reply (owner or manager); returns whether it was new.
  Future<bool> respond(String storeId, String reviewId, String text);
  Future<void> report(
    String storeId,
    String reviewId,
    String reasonCode,
    String? details,
  );

  /// A compressed photo for a review: its media id once processed.
  Future<String> uploadImage(String storeId, File file);
}

class DioReviewsApi implements ReviewsApi {
  DioReviewsApi(this._dio);

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

  static Map<String, dynamic> _body(
    int rating,
    String? text,
    List<String> photoIds,
  ) => {
    'rating': rating,
    'text': (text?.trim().isEmpty ?? true) ? null : text!.trim(),
    'photoIds': photoIds,
  };

  @override
  Future<ReviewPage> page(String storeId, {String? before}) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/stores/$storeId/reviews',
      queryParameters: {'before': ?before},
    );
    return ReviewPage.fromJson(r.data!);
  });

  @override
  Future<ReviewEligibility> eligibility(String storeId) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/stores/$storeId/reviews/eligibility',
    );
    return ReviewEligibility.fromJson(r.data!);
  });

  @override
  Future<WriteResult> submit(
    String storeId, {
    required int rating,
    String? text,
    List<String> photoIds = const [],
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/stores/$storeId/reviews',
      data: _body(rating, text, photoIds),
    );
    return WriteResult.fromJson(r.data!);
  });

  @override
  Future<WriteResult> edit(
    String storeId, {
    required int rating,
    String? text,
    List<String> photoIds = const [],
  }) => _call(() async {
    final r = await _dio.patch<Map<String, dynamic>>(
      '/stores/$storeId/reviews/mine',
      data: _body(rating, text, photoIds),
    );
    return WriteResult.fromJson(r.data!);
  });

  @override
  Future<bool> respond(String storeId, String reviewId, String text) =>
      _call(() async {
        final r = await _dio.put<Map<String, dynamic>>(
          '/stores/$storeId/reviews/$reviewId/response',
          data: {'text': text.trim()},
        );
        return r.data!['created'] as bool;
      });

  @override
  Future<void> report(
    String storeId,
    String reviewId,
    String reasonCode,
    String? details,
  ) => _call(() async {
    await _dio.post<void>(
      '/stores/$storeId/reviews/$reviewId/report',
      data: {
        'reasonCode': reasonCode,
        if (details != null && details.trim().isNotEmpty)
          'details': details.trim(),
      },
    );
  });

  @override
  Future<String> uploadImage(String storeId, File file) => _call(() async {
    final bytes = await file.readAsBytes();
    final base = '/stores/$storeId/reviews/images';
    final presigned = await _dio.post<Map<String, dynamic>>(
      base,
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
    await _dio.post<void>('$base/$mediaId/confirm');
    for (var i = 0; i < _imageReadyPolls; i++) {
      final status = await _dio.get<Map<String, dynamic>>('$base/$mediaId');
      switch (status.data!['status']) {
        case 'ready':
          return mediaId;
        case 'rejected':
        case 'quarantined':
          throw const ReviewPhotoRejected();
      }
      await Future<void>.delayed(_imageReadyInterval);
    }
    throw const ReviewPhotoRejected();
  });
}

/// The photo could not be used (not an image, or it never finished processing).
class ReviewPhotoRejected implements Exception {
  const ReviewPhotoRejected();
}

final reviewsApiProvider = Provider<ReviewsApi>(
  (ref) => DioReviewsApi(ref.watch(dioClientProvider)),
);
