import 'dart:async';

import 'package:amar_elaka_app/core/design/widgets/otp_code_input.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/features/auth/application/auth_controller.dart';
import 'package:amar_elaka_app/features/auth/domain/auth_session_state.dart';
import 'package:amar_elaka_app/features/auth/presentation/otp_verify_screen.dart';
import 'package:amar_elaka_app/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Each verify request spends one of the code's attempts, so the screen must
/// never send a second while one is in flight (found on a device: a burst of
/// "complete" events used every attempt and the code expired).
class _SlowAuthController extends AuthController {
  _SlowAuthController(this.calls, this.answer);

  final List<String> calls;
  final Completer<void> answer;

  @override
  AuthSessionState build() => const AuthSessionUnauthenticated();

  @override
  Future<void> verifyOtp({required String phone, required String code}) {
    calls.add(code);
    return answer.future;
  }
}

void main() {
  testWidgets('a second complete code while one is checked sends nothing', (
    tester,
  ) async {
    final calls = <String>[];
    final answer = Completer<void>();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authControllerProvider.overrideWith(
            () => _SlowAuthController(calls, answer),
          ),
        ],
        child: MaterialApp(
          locale: const Locale('bn'),
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const OtpVerifyScreen(
            args: OtpVerifyArgs(
              phone: '+8801711000077',
              resendAfter: Duration(seconds: 60),
            ),
          ),
        ),
      ),
    );
    final input = tester.widget<OtpCodeInput>(find.byType(OtpCodeInput));
    input.onCompleted('123456');
    input.onCompleted('123456');
    input.onCompleted('654321');
    await tester.pump();
    expect(calls, ['123456']);

    // Once the first answer is back, a new code may be checked.
    answer.completeError(const UnknownApiException());
    await tester.pump();
    input.onCompleted('654321');
    await tester.pump();
    expect(calls, ['123456', '654321']);
  });
}
