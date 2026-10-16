import '../../../core/dynamic_form/bn_numerals.dart';
import '../../../l10n/app_localizations.dart';
import '../../post/presentation/post_error_messages.dart';
import '../domain/capture_rules.dart';

/// Agent mode's codes in words (rule 6: the API sends codes).
abstract final class AgentLabels {
  static String taskType(String type, AppLocalizations l10n) => switch (type) {
    'verify_shop' => l10n.taskTypeVerifyShop,
    'update_info' => l10n.taskTypeUpdateInfo,
    _ => l10n.taskTypeMapShop,
  };

  static String preset(HoursPreset p, AppLocalizations l10n) => switch (p.key) {
    'daily_8_22' => l10n.hoursPresetDaily822,
    'fri_off_10_20' => l10n.hoursPresetFriOff1020,
    _ => l10n.hoursPresetDaily921,
  };

  /// Why the server sent a capture back.
  static String refusal(String? code, String? reason, AppLocalizations l10n) =>
      switch ((code, reason)) {
        (_, 'outside_area') => l10n.refusalOutsideArea,
        (_, 'too_old') => l10n.refusalTooOld,
        (_, 'photos_not_ready' || 'too_many_photos') ||
        ('MEDIA_REFUSED' || 'PHOTO_MISSING', _) => l10n.refusalPhotos,
        (_, 'place_not_found') => l10n.refusalPlaceGone,
        (_, 'nothing_to_update') => l10n.refusalNothingToUpdate,
        (_, 'update_pending') => l10n.refusalUpdatePending,
        ('AGENT_GPS_TOO_INACCURATE', _) => l10n.refusalGps,
        ('AGENT_NOT_ACTIVE', _) => l10n.refusalNotAgent,
        _ => l10n.refusalGeneric(code ?? '?'),
      };

  /// A rejection's moderation reason (the places review queue's).
  static String reason(String? code, AppLocalizations l10n) =>
      describeModerationReason(code, l10n);

  static String digits(Object value, String locale) =>
      localizeDigits('$value', locale);
}
