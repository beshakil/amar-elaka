import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_exception.dart';
import '../../../core/network/dio_client.dart';
import 'info_models.dart';

/// Local information services over REST (apps/api/src/info/info.controller.ts,
/// ADR 064). A phone number arrives only from the two contact calls.
abstract interface class InfoApi {
  Future<Map<String, dynamic>> emergencyJson({double? lat, double? lng});

  /// [board]: `bazar` (the market) or `agri` (farm inputs, ADR 065).
  Future<BazarBoard> bazarBoard({String board = 'bazar'});
  Future<BazarEntrySheet> bazarEntry({String? date, String board = 'bazar'});
  Future<int> saveBazarEntry(String date, List<BazarEntryLine> lines);

  Future<DonorPage> donors({
    required String group,
    required bool compatible,
    double? lat,
    double? lng,
    String? after,
  });
  Future<MyDonor?> myDonor();
  Future<MyDonor?> registerDonor({
    required String bloodGroup,
    required double lat,
    required double lng,
    required String contactWindow,
    required bool sharesNumber,
    required bool alertsEnabled,
    String? lastDonatedOn,
  });
  Future<MyDonor?> setAvailable(bool available);
  Future<MyDonor?> recordDonation(String donatedOn);
  Future<void> withdraw();
  Future<List<DonorContactEntry>> myContacts();
  Future<ContactOutcome> contactDonor(
    String donorId, {
    required String channel,
    String? requestId,
  });

  Future<({String id, int alerted})> createRequest({
    required String bloodGroup,
    required int units,
    required String hospitalName,
    required double lat,
    required double lng,
    required DateTime neededBy,
    required String urgency,
    String? patientNote,
  });
  Future<List<BloodRequestCard>> requests({double? lat, double? lng});
  Future<List<BloodRequestCard>> myRequests();
  Future<BloodRequestDetail> request(String id);
  Future<String> contactRequester(String id, {required String channel});
  Future<void> closeRequest(String id, String outcome);
}

class DioInfoApi implements InfoApi {
  DioInfoApi(this._dio);

  final Dio _dio;

  Future<T> _call<T>(Future<T> Function() request) async {
    try {
      return await request();
    } on DioException catch (e) {
      throw mapDioException(e);
    }
  }

  static Map<String, Object> _origin(double? lat, double? lng) => {
    if (lat != null && lng != null) ...{'lat': lat, 'lng': lng},
  };

  @override
  Future<Map<String, dynamic>> emergencyJson({double? lat, double? lng}) =>
      _call(() async {
        final r = await _dio.get<Map<String, dynamic>>(
          '/info/emergency',
          queryParameters: _origin(lat, lng),
        );
        return r.data!;
      });

  @override
  Future<BazarBoard> bazarBoard({String board = 'bazar'}) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/bazar/board',
      queryParameters: {'board': board},
    );
    return BazarBoard.fromJson(r.data!);
  });

  @override
  Future<BazarEntrySheet> bazarEntry({String? date, String board = 'bazar'}) =>
      _call(() async {
        final r = await _dio.get<Map<String, dynamic>>(
          '/bazar/entry',
          queryParameters: {'date': ?date, 'board': board},
        );
        return BazarEntrySheet.fromJson(r.data!);
      });

  @override
  Future<int> saveBazarEntry(String date, List<BazarEntryLine> lines) =>
      _call(() async {
        final r = await _dio.put<Map<String, dynamic>>(
          '/bazar/entry',
          data: {
            'date': date,
            'items': [for (final l in lines) l.toJson()],
          },
        );
        return (r.data!['saved'] as num).toInt();
      });

  @override
  Future<DonorPage> donors({
    required String group,
    required bool compatible,
    double? lat,
    double? lng,
    String? after,
  }) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>(
      '/blood/donors',
      queryParameters: {
        'group': group,
        'compatible': '$compatible',
        ..._origin(lat, lng),
        'after': ?after,
      },
    );
    return DonorPage.fromJson(r.data!);
  });

  @override
  Future<MyDonor?> myDonor() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/blood/me');
    return MyDonor.fromJson(r.data!);
  });

  @override
  Future<MyDonor?> registerDonor({
    required String bloodGroup,
    required double lat,
    required double lng,
    required String contactWindow,
    required bool sharesNumber,
    required bool alertsEnabled,
    String? lastDonatedOn,
  }) => _call(() async {
    final r = await _dio.put<Map<String, dynamic>>(
      '/blood/me',
      data: {
        'bloodGroup': bloodGroup,
        'location': {'lat': lat, 'lng': lng},
        'lastDonatedOn': ?lastDonatedOn,
        'contactWindow': contactWindow,
        'contactPreference': sharesNumber ? 'reveal_on_request' : 'in_app_only',
        'alertsEnabled': alertsEnabled,
        'eligibilityConfirmed': true,
        'consent': true,
      },
    );
    return MyDonor.fromJson(r.data!);
  });

  @override
  Future<MyDonor?> setAvailable(bool available) => _call(() async {
    final r = await _dio.patch<Map<String, dynamic>>(
      '/blood/me/availability',
      data: {'available': available},
    );
    return MyDonor.fromJson(r.data!);
  });

  @override
  Future<MyDonor?> recordDonation(String donatedOn) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/blood/me/donations',
      data: {'donatedOn': donatedOn},
    );
    return MyDonor.fromJson(r.data!);
  });

  @override
  Future<void> withdraw() => _call(() async {
    await _dio.delete<void>('/blood/me');
  });

  @override
  Future<List<DonorContactEntry>> myContacts() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/blood/me/contacts');
    return [
      for (final c in r.data!['items'] as List)
        DonorContactEntry.fromJson(c as Map<String, dynamic>),
    ];
  });

  @override
  Future<ContactOutcome> contactDonor(
    String donorId, {
    required String channel,
    String? requestId,
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/blood/donors/$donorId/contact',
      data: {'channel': channel, 'requestId': ?requestId},
    );
    final reveal = r.data!['reveal'] as Map<String, dynamic>?;
    return ContactOutcome(href: reveal?['href'] as String?);
  });

  @override
  Future<({String id, int alerted})> createRequest({
    required String bloodGroup,
    required int units,
    required String hospitalName,
    required double lat,
    required double lng,
    required DateTime neededBy,
    required String urgency,
    String? patientNote,
  }) => _call(() async {
    final r = await _dio.post<Map<String, dynamic>>(
      '/blood/requests',
      data: {
        'bloodGroup': bloodGroup,
        'units': units,
        'hospitalName': hospitalName,
        'location': {'lat': lat, 'lng': lng},
        'neededBy': neededBy.toUtc().toIso8601String(),
        'urgency': urgency,
        if (patientNote != null && patientNote.trim().isNotEmpty)
          'patientNote': patientNote.trim(),
      },
    );
    return (
      id: r.data!['id'] as String,
      alerted: (r.data!['alertedDonors'] as num).toInt(),
    );
  });

  @override
  Future<List<BloodRequestCard>> requests({double? lat, double? lng}) =>
      _call(() async {
        final r = await _dio.get<Map<String, dynamic>>(
          '/blood/requests',
          queryParameters: _origin(lat, lng),
        );
        return [
          for (final c in r.data!['items'] as List)
            BloodRequestCard.fromJson(c as Map<String, dynamic>),
        ];
      });

  @override
  Future<List<BloodRequestCard>> myRequests() => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/blood/requests/mine');
    return [
      for (final c in r.data!['items'] as List)
        BloodRequestCard.fromJson(c as Map<String, dynamic>),
    ];
  });

  @override
  Future<BloodRequestDetail> request(String id) => _call(() async {
    final r = await _dio.get<Map<String, dynamic>>('/blood/requests/$id');
    return BloodRequestDetail.fromJson(r.data!);
  });

  @override
  Future<String> contactRequester(String id, {required String channel}) =>
      _call(() async {
        final r = await _dio.post<Map<String, dynamic>>(
          '/blood/requests/$id/contact',
          data: {'channel': channel},
        );
        return r.data!['href'] as String;
      });

  @override
  Future<void> closeRequest(String id, String outcome) => _call(() async {
    await _dio.post<void>(
      '/blood/requests/$id/close',
      data: {'outcome': outcome},
    );
  });
}

final infoApiProvider = Provider<InfoApi>(
  (ref) => DioInfoApi(ref.watch(dioClientProvider)),
);
