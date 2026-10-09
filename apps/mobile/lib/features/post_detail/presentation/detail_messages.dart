import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';

/// Every contact/report/save failure as a Bengali sentence: what happened
/// and what to do (never the API's English message).
String detailErrorMessage(
  AppException error,
  AppLocalizations l10n,
  String locale,
) {
  if (error is! ApiException) return l10n.detailOffline;
  return switch (error.code) {
    'CONTACT_LOGIN_REQUIRED' => l10n.detailContactLoginRequired,
    'CONTACT_LIMIT_REACHED' => l10n.detailContactLimit(
      localizeDigits('${_max(error)}', locale),
    ),
    'CONTACT_CHANNEL_UNAVAILABLE' => l10n.detailContactUnavailable,
    'CONTACT_OWN_STORE' => l10n.storeContactOwn,
    'CONTACT_POST_NOT_LIVE' => l10n.detailContactNotLive,
    'REPORT_OWN_POST' => l10n.detailReportOwn,
    'REPORT_LIMIT_REACHED' => l10n.detailReportLimit,
    'POST_NOT_FOUND' => l10n.detailNotFoundTitle,
    _ => l10n.detailActionFailed,
  };
}

int? _max(ApiException error) => switch (error.body.details) {
  {'max': final int max} => max,
  _ => null,
};
