import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import 'verification_models.dart';

/// Verification over REST (ADR 062). The NID number goes only in the body of
/// one request and is never kept on the phone; evidence is uploaded as
/// private files (the API strips photos of their metadata).
abstract interface class VerificationApi {
  Future<MyVerifications> mine();
  Future<void> submitIdentity({
    required String nid,
    required String selfieMediaId,
  });
  Future<StoreVerification> store(String storeId);
  Future<void> submitBusiness(
    String storeId, {
    required String licenceMediaId,
    required String shopFrontMediaId,
  });

  /// A compressed photo for identity (storeId null) or a store's verification: its media id once processed.
  Future<String> uploadEvidence(File file, {String? storeId});
}

class DioVerificationApi implements VerificationApi {
  DioVerificationApi(this._dio);

  final Dio _dio;

  static const _readyPolls = 20;
  static const _readyInterval = Duration(milliseconds: 750);

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<MyVerifications> mine() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/me/verifications');
    return MyVerifications.fromJson(r.data!);
  });

  @override
  Future<void> submitIdentity({
    required String nid,
    required String selfieMediaId,
  }) => _call(() async {
    await _dio.post<void>(
      '/me/verifications/identity',
      data: {'nid': nid, 'selfieMediaId': selfieMediaId},
    );
  });

  @override
  Future<StoreVerification> store(String storeId) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/stores/$storeId/verification',
    );
    return StoreVerification.fromJson(r.data!);
  });

  @override
  Future<void> submitBusiness(
    String storeId, {
    required String licenceMediaId,
    required String shopFrontMediaId,
  }) => _call(() async {
    await _dio.post<void>(
      '/stores/$storeId/verification',
      data: {
        'licenceMediaId': licenceMediaId,
        'shopFrontMediaId': shopFrontMediaId,
      },
    );
  });

  @override
  Future<String> uploadEvidence(File file, {String? storeId}) =>
      _call(() async {
        final base = storeId == null
            ? '/me/verifications/evidence'
            : '/stores/$storeId/verification/evidence';
        final bytes = await file.readAsBytes();
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
        for (var i = 0; i < _readyPolls; i++) {
          final status = await _dio.get<Map<String, dynamic>>('$base/$mediaId');
          switch (status.data!['status']) {
            case 'ready':
              return mediaId;
            case 'rejected':
            case 'quarantined':
              throw const EvidenceRejected();
          }
          await Future<void>.delayed(_readyInterval);
        }
        throw const EvidenceRejected();
      });
}

/// The photo could not be used.
class EvidenceRejected implements Exception {
  const EvidenceRejected();
}

final verificationApiProvider = Provider<VerificationApi>(
  (ref) => DioVerificationApi(ref.watch(dioClientProvider)),
);
