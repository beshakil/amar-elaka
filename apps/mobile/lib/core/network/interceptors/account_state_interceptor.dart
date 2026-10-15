import 'package:dio/dio.dart';

import '../account_gate.dart';

/// Turns the API's account refusals into an [AccountGate] (ADR 063). The
/// error still reaches the caller unchanged; the router reacts to the gate.
class AccountStateInterceptor extends Interceptor {
  AccountStateInterceptor(this.onGate);

  final void Function(AccountGate gate) onGate;

  @override
  void onError(DioException err, ErrorInterceptorHandler handler) {
    final data = err.response?.data;
    if (err.response?.statusCode == 403 && data is Map) {
      switch (data['error']) {
        case 'ACCOUNT_BANNED':
          onGate(AccountGate.banned);
        case 'ACCOUNT_TERMINATED':
          onGate(AccountGate.terminated);
      }
    }
    handler.next(err);
  }
}
