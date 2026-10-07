import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';

/// A report reason as the sheet shows it.
String placeReportReasonLabel(String code, AppLocalizations l10n) =>
    switch (code) {
      'wrong_location' => l10n.placeReportWrongLocation,
      'closed_permanently' => l10n.placeReportClosed,
      'duplicate' => l10n.placeReportDuplicate,
      'wrong_information' => l10n.placeReportWrongInfo,
      _ => l10n.placeReportInappropriate,
    };

/// A failed report or suggestion, in one sentence.
String placeFeedbackError(
  AppException error,
  AppLocalizations l10n,
  String locale,
) {
  if (error is NetworkException || error is TimeoutException) {
    return l10n.placeFeedbackOffline;
  }
  if (error is! ApiException) return l10n.placeFeedbackFailed;
  return switch (error.code) {
    'PLACE_REPORT_OWN_PLACE' => l10n.placeReportOwn,
    'REPORT_LIMIT_REACHED' ||
    'PLACE_SUGGESTION_LIMIT_REACHED' => l10n.placeFeedbackLimit,
    'PLACE_SUGGESTION_PENDING_EXISTS' => l10n.placeSuggestPending,
    'PLACE_SUGGESTION_NO_CHANGE' => l10n.placeSuggestNoChange,
    'PLACE_LOCATION_OTHER_TENANT' => l10n.placeSuggestOtherArea,
    'PLACE_PHONE_INVALID' => l10n.placeSuggestPhoneInvalid,
    'PLACE_TOO_MANY_PHONES' => l10n.placeSuggestTooManyPhones(
      localizeDigits('${_max(error) ?? ''}', locale),
    ),
    'PLACE_NOT_FOUND' => l10n.placeFeedbackGone,
    'PLACE_DUPLICATE_TARGET_INVALID' => l10n.placeReportDuplicateFar,
    _ => l10n.placeFeedbackFailed,
  };
}

int? _max(ApiException error) => switch (error.body.details) {
  {'max': final int max} => max,
  _ => null,
};
