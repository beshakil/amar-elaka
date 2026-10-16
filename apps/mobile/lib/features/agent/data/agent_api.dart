import 'package:amar_elaka_api/amar_elaka_api.dart' show CatalogCategory;
import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import 'agent_models.dart';

/// Field agent mode over REST (apps/api/src/agents, ADR 066).
abstract interface class AgentApi {
  Future<AgentMe> me();
  Future<List<AgentCategory>> placeCategories();
  Future<AgentToday> today();
  Future<AgentStats> stats();

  /// One queued capture; idempotent by its `id`.
  Future<SubmissionResult> submit(Map<String, Object?> body);
  Future<int> requestPhoneOtp(String submissionId, String phone);
  Future<void> verifyPhoneOtp(String submissionId, String phone, String code);
}

class DioAgentApi implements AgentApi {
  DioAgentApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  @override
  Future<AgentMe> me() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/agent/me');
    return AgentMe.fromJson(r.data!);
  });

  @override
  Future<List<AgentCategory>> placeCategories() => _call(() async {
    final r = await _dio.get<List<dynamic>>('/categories');
    return [
      for (final item in r.data!)
        if (CatalogCategory.fromJson(item as Map<String, dynamic>) case final c
            when c.kind == 'place')
          AgentCategory(
            id: c.id,
            nameBn: c.name.bn,
            nameEn: c.name.en,
            iconKey: c.iconKey,
          ),
    ];
  });

  @override
  Future<AgentToday> today() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/agent/today');
    return AgentToday.fromJson(r.data!);
  });

  @override
  Future<AgentStats> stats() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/agent/me/stats');
    return AgentStats.fromJson(r.data!);
  });

  @override
  Future<SubmissionResult> submit(Map<String, Object?> body) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/agent/submissions',
      data: body,
    );
    return SubmissionResult.fromJson(r.data!);
  });

  @override
  Future<int> requestPhoneOtp(String submissionId, String phone) =>
      _call(() async {
        final r = await _dio.post<Map<String, dynamic>>(
          '/agent/submissions/$submissionId/phone-otp',
          data: {'phone': phone},
        );
        return (r.data!['resendAfterSeconds'] as num).toInt();
      });

  @override
  Future<void> verifyPhoneOtp(String submissionId, String phone, String code) =>
      _call(() async {
        await _dio.post<Map<String, dynamic>>(
          '/agent/submissions/$submissionId/phone-otp/verify',
          data: {'phone': phone, 'code': code},
        );
      });
}

final agentApiProvider = Provider<AgentApi>(
  (ref) => DioAgentApi(ref.watch(dioClientProvider)),
);
