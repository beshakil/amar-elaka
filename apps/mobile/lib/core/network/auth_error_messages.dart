import 'api_exception.dart';
import '../../l10n/app_localizations.dart';

/// Every failure an auth screen can hit, in Bengali (or the active locale) —
/// never a raw `e.message` (English, backend-internal wording) shown to the
/// user. Switches on [ApiException.code] against the real backend codes
/// (apps/api/src/auth/exceptions/auth.exceptions.ts); anything not
/// recognized here falls through to a generic message rather than throwing,
/// since a new/unmapped backend code must never crash the screen showing it.
String describeAuthError(AppException error, AppLocalizations l10n) {
  switch (error) {
    case NetworkException():
      return l10n.errorNetworkMessage;
    case TimeoutException():
      return l10n.errorTimeoutMessage;
    case ApiException(:final code):
      return _describeApiError(code, error, l10n);
    case UnknownApiException():
      return l10n.errorGenericMessage;
  }
}

String _describeApiError(
  String code,
  ApiException error,
  AppLocalizations l10n,
) {
  return switch (code) {
    'OTP_RATE_LIMITED_COOLDOWN' => l10n.errorOtpCooldownMessage,
    'OTP_RATE_LIMITED_PHONE_DAILY' => l10n.errorOtpPhoneDailyLimitMessage,
    'OTP_RATE_LIMITED_IP_DAILY' => l10n.errorOtpIpDailyLimitMessage,
    'OTP_EXPIRED' => l10n.errorOtpExpiredMessage,
    'OTP_INCORRECT' => l10n.errorOtpIncorrectMessage,
    'OTP_TOO_MANY_ATTEMPTS' => l10n.errorOtpTooManyAttemptsMessage,
    'INVALID_CREDENTIALS' => l10n.errorInvalidCredentialsMessage,
    'ACCOUNT_RESTRICTED' => l10n.errorAccountRestrictedMessage,
    'ACCOUNT_BANNED' => l10n.errorAccountBannedMessage,
    'ACCOUNT_TERMINATED' => l10n.errorAccountTerminatedMessage,
    'GOOGLE_ACCOUNT_NOT_LINKED' => l10n.errorGoogleAccountNotLinkedMessage,
    'GOOGLE_ACCOUNT_ALREADY_LINKED' =>
      l10n.errorGoogleAccountAlreadyLinkedMessage,
    'EMAIL_ALREADY_REGISTERED' => l10n.errorEmailAlreadyRegisteredMessage,
    'WEAK_PASSWORD' => l10n.errorWeakPasswordMessage,
    'DISPLAY_NAME_TOO_LONG' => l10n.errorDisplayNameTooLongMessage,
    'INVALID_PHONE' => l10n.errorInvalidPhoneMessage,
    'VALIDATION_FAILED' => l10n.errorValidationFailedMessage,
    _ => l10n.errorGenericMessage,
  };
}
