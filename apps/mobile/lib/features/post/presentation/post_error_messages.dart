import 'package:amar_elaka_api/amar_elaka_api.dart';
import 'package:intl/intl.dart';

import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';

/// Every failure the post screens can hit, as a specific sentence in the
/// user's language — what happened and what to do — never "something went
/// wrong" and never the API's English message. Switches on the backend's
/// codes (apps/api/src/posts/posts.exceptions.ts and friends); an unknown
/// code still names itself so support can tell what it was.
String describePostError(
  AppException error,
  AppLocalizations l10n,
  String locale,
) {
  switch (error) {
    case NetworkException():
      return l10n.postErrorNetwork;
    case TimeoutException():
      return l10n.postErrorTimeout;
    case GoogleSignInFailedException():
    case UnknownApiException():
      return l10n.postErrorUnknown('APP');
    case ApiException():
      return _describe(error, l10n, locale);
  }
}

String _describe(ApiException error, AppLocalizations l10n, String locale) {
  final details = error.body.details;
  final issues = details is Map ? details : const <Object?, Object?>{};
  String number(Object? value) => localizeDigits('${value ?? ''}', locale);

  switch (error.code) {
    case 'POST_LIMIT_REACHED':
      return issues['limit'] == 'daily'
          ? l10n.postErrorLimitDaily(number(issues['max']))
          : l10n.postErrorLimitActive(number(issues['max']));
    case 'POST_TEXT_TOO_LONG':
      return issues['field'] == 'description'
          ? l10n.postErrorDescriptionTooLong(number(issues['max']))
          : l10n.postErrorTitleTooLong(number(issues['max']));
    case 'FIELD_VALIDATION_FAILED':
      return l10n.postErrorFields;
    case 'POST_MEDIA_INVALID':
    case 'UPLOAD_MISSING':
    case 'UPLOAD_REJECTED':
      return l10n.postErrorMediaInvalid;
    case 'POST_MEDIA_TENANT_MISMATCH':
      return l10n.postErrorMediaTenantMismatch;
    case 'POST_TOO_MANY_MEDIA':
      return l10n.postErrorTooManyMedia;
    case 'UPLOAD_RATE_LIMITED':
      return l10n.postErrorUploadRateLimited;
    case 'CATEGORY_NOT_POSTABLE':
    case 'CATEGORY_NOT_FOUND':
    case 'CATEGORY_HAS_NO_FIELD_SCHEMA':
      return l10n.postErrorCategoryNotPostable;
    case 'POST_NOT_EDITABLE':
      return l10n.postErrorNotEditable;
    case 'POST_ILLEGAL_TRANSITION':
      return l10n.postErrorIllegalTransition;
    case 'POST_NOT_FOUND':
      return l10n.postErrorNotFound;
    case 'POST_NOT_OWNER':
      return l10n.postErrorNotOwner;
    case 'POST_RENEW_TOO_EARLY':
      final from = DateTime.tryParse('${issues['renewableFrom']}')?.toLocal();
      return l10n.postErrorRenewTooEarly(
        from == null
            ? ''
            : localizeDigits(DateFormat.MMMMd(locale).format(from), locale),
      );
    case 'IDEMPOTENCY_KEY_REUSED':
      return l10n.postErrorIdempotencyReused;
    case 'IDEMPOTENT_REQUEST_IN_PROGRESS':
      return l10n.postErrorInProgress;
    case 'LOCATION_NOT_FOUND':
      return l10n.postErrorLocationNotFound;
    case 'UNAUTHENTICATED':
    case 'REFRESH_TOKEN_EXPIRED':
    case 'REFRESH_TOKEN_INVALID':
    case 'REFRESH_TOKEN_REUSED':
      return l10n.postErrorSignIn;
    case 'ACCOUNT_RESTRICTED':
    case 'ACCOUNT_BANNED':
    case 'ACCOUNT_TERMINATED':
      return l10n.postErrorAccountRestricted;
    case 'PERMISSION_DENIED':
    case 'OWNERSHIP_REQUIRED':
      return l10n.postErrorPermission;
    case 'TENANT_REQUIRED':
    case 'TENANT_NOT_FOUND':
    case 'TENANT_MISMATCH':
    case 'TENANT_SUSPENDED':
    case 'TENANT_TERMINATED':
    case 'TENANT_ID_INVALID':
      return l10n.postErrorTenant;
    case 'VALIDATION_FAILED':
      final paths = {
        for (final issue in error.validationIssues ?? const <ValidationIssue>[])
          issue.path.split('.').first,
      };
      if (paths.contains('contactPhone')) return l10n.postErrorContactPhone;
      return l10n.postErrorValidation(paths.join(', '));
  }
  return error.statusCode >= 500
      ? l10n.postErrorServer(error.code)
      : l10n.postErrorUnknown(error.code);
}

/// The moderator's reason code (ADR 005's takedown reasons) in words.
String describeModerationReason(String? code, AppLocalizations l10n) =>
    switch (code) {
      'spam' => l10n.reasonSpam,
      'wrong_category' => l10n.reasonWrongCategory,
      'duplicate' => l10n.reasonDuplicate,
      'policy_violation' => l10n.reasonPolicyViolation,
      'prohibited_item' => l10n.reasonProhibitedItem,
      'scam_suspected' => l10n.reasonScamSuspected,
      'poor_quality_listing' => l10n.reasonPoorQuality,
      'contact_info_exposed' => l10n.reasonContactExposed,
      'illegal_content' || 'csam' => l10n.reasonIllegal,
      'doxxing' => l10n.reasonPrivacy,
      'credible_threat' => l10n.reasonThreat,
      _ => l10n.reasonOther,
    };
