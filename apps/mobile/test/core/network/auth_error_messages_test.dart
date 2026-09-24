import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:amar_elaka_app/core/network/api_exception.dart';
import 'package:amar_elaka_app/core/network/auth_error_messages.dart';
import 'package:amar_elaka_app/l10n/app_localizations_bn.dart';
import 'package:amar_elaka_app/l10n/app_localizations_en.dart';
import 'package:flutter_test/flutter_test.dart';

ApiException _apiError(String code) => ApiException(
  ApiErrorBody(statusCode: 400, error: code, message: 'irrelevant'),
);

void main() {
  final bn = AppLocalizationsBn();
  final en = AppLocalizationsEn();

  group('describeAuthError', () {
    test('maps network/timeout/unknown to their generic messages', () {
      expect(
        describeAuthError(const NetworkException(), bn),
        bn.errorNetworkMessage,
      );
      expect(
        describeAuthError(const TimeoutException(), bn),
        bn.errorTimeoutMessage,
      );
      expect(
        describeAuthError(const UnknownApiException(), bn),
        bn.errorGenericMessage,
      );
    });

    test(
      'maps every known backend error code to its own (non-generic) message, in both locales',
      () {
        const codes = [
          'OTP_RATE_LIMITED_COOLDOWN',
          'OTP_RATE_LIMITED_PHONE_DAILY',
          'OTP_RATE_LIMITED_IP_DAILY',
          'OTP_EXPIRED',
          'OTP_INCORRECT',
          'OTP_TOO_MANY_ATTEMPTS',
          'INVALID_CREDENTIALS',
          'ACCOUNT_RESTRICTED',
          'ACCOUNT_BANNED',
          'ACCOUNT_TERMINATED',
          'GOOGLE_ACCOUNT_NOT_LINKED',
          'GOOGLE_ACCOUNT_ALREADY_LINKED',
          'EMAIL_ALREADY_REGISTERED',
          'WEAK_PASSWORD',
          'DISPLAY_NAME_TOO_LONG',
          'INVALID_PHONE',
          'VALIDATION_FAILED',
        ];

        for (final code in codes) {
          for (final l10n in [bn, en]) {
            final message = describeAuthError(_apiError(code), l10n);
            expect(
              message,
              isNot(l10n.errorGenericMessage),
              reason: '$code in ${l10n.localeName}',
            );
            expect(message, isNotEmpty, reason: '$code in ${l10n.localeName}');
          }
        }
      },
    );

    test(
      'falls back to the generic message for an unrecognized code, never throws',
      () {
        expect(
          describeAuthError(_apiError('SOME_FUTURE_CODE'), bn),
          bn.errorGenericMessage,
        );
      },
    );
  });
}
