import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/network/interceptors/auth_interceptor.dart';
import 'ban_models.dart';

/// Bans, appeals and complaints over REST (ADR 063). The public appeal calls
/// carry no session (skipAuth): a terminated person has none.
abstract interface class BanApi {
  Future<List<BanNotice>> notices();
  Future<String> appeal({required String targetId, required String statement});

  /// Always "accepted" — whether the phone has a ban is never revealed; the
  /// resend wait comes back.
  Future<Duration> requestAppealOtp(String phone);
  Future<PublicAppealStatus> appealStatus({
    required String phone,
    required String otp,
  });
  Future<String> publicAppeal({
    required String phone,
    required String appealToken,
    required String reference,
    required String statement,
  });

  Future<String> complain({
    required String subjectType,
    required ComplaintCategory category,
    required String description,
    String? subjectId,
    String? postId,
  });
  Future<List<MyComplaint>> myComplaints();
}

class DioBanApi implements BanApi {
  DioBanApi(this._dio);

  final Dio _dio;

  static final _public = Options(extra: {skipAuthKey: true});

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<List<BanNotice>> notices() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/account/bans');
    return banNoticesOf(r.data!['items']);
  });

  @override
  Future<String> appeal({
    required String targetId,
    required String statement,
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/account/appeals',
      data: {'targetId': targetId, 'statement': statement},
    );
    return r.data!['reference'] as String;
  });

  @override
  Future<Duration> requestAppealOtp(String phone) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/appeals/request-otp',
      data: {'phone': phone},
      options: _public,
    );
    return Duration(
      seconds: (r.data!['resendAfterSeconds'] as num?)?.toInt() ?? 0,
    );
  });

  @override
  Future<PublicAppealStatus> appealStatus({
    required String phone,
    required String otp,
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/appeals/status',
      data: {'phone': phone, 'otp': otp},
      options: _public,
    );
    return PublicAppealStatus.fromJson(r.data!);
  });

  @override
  Future<String> publicAppeal({
    required String phone,
    required String appealToken,
    required String reference,
    required String statement,
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/appeals/submit',
      data: {
        'phone': phone,
        'appealToken': appealToken,
        'reference': reference,
        'statement': statement,
      },
      options: _public,
    );
    return r.data!['reference'] as String;
  });

  @override
  Future<String> complain({
    required String subjectType,
    required ComplaintCategory category,
    required String description,
    String? subjectId,
    String? postId,
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/complaints',
      data: {
        'subjectType': subjectType,
        'subjectId': ?subjectId,
        'category': complaintCategoryCode(category),
        'description': description,
        'postId': ?postId,
      },
    );
    return r.data!['reference'] as String;
  });

  @override
  Future<List<MyComplaint>> myComplaints() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/complaints/mine');
    return [
      for (final c in r.data!['items'] as List)
        MyComplaint.fromJson(c as Map<String, dynamic>),
    ];
  });
}

final banApiProvider = Provider<BanApi>(
  (ref) => DioBanApi(ref.watch(dioClientProvider)),
);
