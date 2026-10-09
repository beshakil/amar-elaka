import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../core/network/api_exception.dart';
import '../../../l10n/app_localizations.dart';

/// A Bengali sentence for each store error code the seller can hit (ADR 054).
String storeErrorMessage(
  AppException error,
  AppLocalizations l10n,
  String locale,
) {
  if (error is! ApiException) return l10n.storeErrorGeneric;
  final details = error.body.details is Map<String, dynamic>
      ? error.body.details! as Map<String, dynamic>
      : const <String, dynamic>{};
  return switch (error.code) {
    'STORE_LIMIT_REACHED' => l10n.storeErrorLimit,
    'STORE_LOCATION_OUTSIDE_AREA' => l10n.storeErrorOutsideArea,
    'STORE_PHONE_INVALID' => l10n.storeErrorPhone,
    'STORE_CATEGORY_INVALID' => l10n.storeErrorCategory,
    'STORE_NAME_TOO_LONG' ||
    'STORE_DESCRIPTION_TOO_LONG' => l10n.storeErrorNameTooLong,
    'STORE_ACTION_FORBIDDEN' || 'HOURS_NOT_EDITOR' => l10n.storeErrorForbidden,
    'STORE_MEDIA_INVALID' => l10n.storePhotoFailed,
    'STORE_STAFF_LIMIT_REACHED' => l10n.staffErrorLimit,
    'STORE_ALREADY_STAFF' => l10n.staffErrorAlready,
    'STORE_INVITEE_REFUSED' => l10n.staffErrorRefused,
    'HOURS_TOO_MANY_RANGES' => l10n.hoursTooMany(
      localizeDigits('${details['max'] ?? ''}', locale),
    ),
    _ => l10n.storeErrorGeneric,
  };
}
